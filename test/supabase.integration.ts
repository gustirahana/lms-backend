import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { json, urlencoded } from 'express';
import { io, Socket } from 'socket.io-client';

interface SupabaseStatus {
  API_URL: string;
  PUBLISHABLE_KEY: string;
  SECRET_KEY: string;
  SERVICE_ROLE_KEY: string;
}

function readLocalStatus(): SupabaseStatus {
  let output: string;

  try {
    output = execFileSync('node_modules/.bin/supabase', ['status', '--output', 'json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    throw new Error('Could not read local Supabase status. Start the local stack with npm run db:start first.');
  }

  const jsonStart = output.indexOf('{');

  if (jsonStart < 0) {
    throw new Error('Local Supabase status did not return JSON.');
  }

  let status: Partial<SupabaseStatus>;

  try {
    status = JSON.parse(output.slice(jsonStart)) as Partial<SupabaseStatus>;
  } catch {
    throw new Error('Local Supabase status returned invalid JSON.');
  }

  for (const key of ['API_URL', 'PUBLISHABLE_KEY', 'SECRET_KEY', 'SERVICE_ROLE_KEY'] as const) {
    if (typeof status[key] !== 'string' || !status[key]) {
      throw new Error(`Local Supabase status is missing ${key}.`);
    }
  }

  const apiUrl = new URL(status.API_URL!);
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

  if (apiUrl.protocol !== 'http:' || !loopbackHosts.has(apiUrl.hostname)) {
    throw new Error('Refusing integration smoke: SUPABASE_URL must be an HTTP loopback address.');
  }

  return status as SupabaseStatus;
}

function cookiePair(setCookie: string | null): string {
  assert.ok(setCookie, 'Expected the backend to issue a session cookie');
  assert.match(setCookie, /(?:^|;\s*)HttpOnly(?:;|$)/i);
  assert.match(setCookie, /(?:^|;\s*)SameSite=Lax(?:;|$)/i);
  const pair = setCookie.split(';', 1)[0];
  assert.ok(pair.includes('='));
  return pair;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function connectSocket(url: string, origin: string, cookie: string): Promise<Socket> {
  const socket = io(url, {
    transports: ['websocket'],
    forceNew: true,
    autoConnect: false,
    extraHeaders: { Origin: origin, Cookie: cookie },
    timeout: 5000,
  });

  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error) => reject(error));
    socket.connect();
  });
}

function waitForSocketEvent<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, resolve));
}

function waitForSocketDisconnect(socket: Socket): Promise<void> {
  if (!socket.connected) {
    return Promise.resolve();
  }

  return new Promise((resolve) => socket.once('disconnect', () => resolve()));
}

async function run(): Promise<void> {
  const supabase = readLocalStatus();
  console.log('Local Supabase API URL is loopback; Docker host port bindings may still be exposed on all interfaces.');
  const authSettingsResponse = await fetch(`${supabase.API_URL}/auth/v1/settings`, {
    headers: { apikey: supabase.PUBLISHABLE_KEY },
  });
  assert.equal(authSettingsResponse.status, 200, 'Local Supabase Auth settings must be reachable');
  const authSettings = await authSettingsResponse.json() as {
    disable_signup?: boolean;
    external?: { email?: boolean };
  };
  assert.equal(authSettings.disable_signup, true, 'Local public signup must stay disabled');
  assert.equal(authSettings.external?.email, true, 'Local email/password Auth provider must be enabled');
  const origin = 'http://127.0.0.1:5173';
  const email = `lms-local-smoke-${Date.now()}-${randomBytes(4).toString('hex')}@example.test`;
  const password = `LocalSmoke-${randomBytes(18).toString('base64url')}aA1!`;
  let userId: string | undefined;
  let realtimeCourseId: string | undefined;
  const realtimeUserIds: string[] = [];
  const realtimeSockets: Socket[] = [];

  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = supabase.API_URL;
  process.env.SUPABASE_PUBLISHABLE_KEY = supabase.PUBLISHABLE_KEY;
  process.env.SUPABASE_SECRET_KEY = supabase.SECRET_KEY;
  process.env.AUTH_ENCRYPTION_KEY_VERSION = 'v1';
  process.env.AUTH_ENCRYPTION_KEYS = `v1:${randomBytes(32).toString('base64')}`;
  process.env.FRONTEND_ORIGINS = origin;

  const { NestFactory } = await import('@nestjs/core');
  const { ValidationPipe } = await import('@nestjs/common');
  const { AppModule } = await import('../src/app.module');
  const { loadConfig } = await import('../src/config');
  const { originCheck } = await import('../src/security/origin-check.middleware');
  const { ApiRateLimitMiddleware } = await import('../src/security/rate-limit.middleware');
  const { securityHeaders } = await import('../src/security/security-headers.middleware');
  console.log('Backend modules loaded.');
  const config = loadConfig(process.env);
  const app = await NestFactory.create(AppModule, { bodyParser: false, logger: ['error'] });
  console.log('Backend Nest application created.');
  let baseUrl: string | undefined;

  try {
    app.setGlobalPrefix('api');
    app.getHttpAdapter().getInstance().set('trust proxy', 0);
    app.use(securityHeaders(config.isProduction));
    app.use(json({ limit: config.bodyLimit }));
    app.use(urlencoded({ extended: false, limit: config.bodyLimit }));
    app.use(originCheck(config.frontendOrigins));
    app.use(new ApiRateLimitMiddleware(
      config.rateLimitMax,
      config.rateLimitWindowMs,
      config.authRateLimitMax,
      config.authRateLimitWindowMs,
    ).use);
    app.enableCors({
      origin: config.frontendOrigins,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-App-Name', 'X-App-Version', 'X-App-Device'],
      credentials: true,
    });
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    }));
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    console.log('Backend test server started on loopback.');

    const staleCourseCleanup = await fetch(
      `${supabase.API_URL}/rest/v1/courses?title=eq.Realtime%20Integration%20Course`,
      { method: 'DELETE', headers: { apikey: supabase.SECRET_KEY, Prefer: 'return=minimal' } },
    );
    assert.equal(staleCourseCleanup.status, 204, 'Prior synthetic realtime course cleanup should succeed');
    const staleUsersResponse = await fetch(`${supabase.API_URL}/auth/v1/admin/users?page=1&per_page=1000`, {
      headers: {
        apikey: supabase.PUBLISHABLE_KEY,
        Authorization: `Bearer ${supabase.SERVICE_ROLE_KEY}`,
      },
    });
    assert.equal(staleUsersResponse.status, 200, 'Local Auth admin user listing should be available for synthetic fixture cleanup');
    const staleUsers = await staleUsersResponse.json() as { users?: Array<{ id: string; email?: string }> };
    for (const staleUser of staleUsers.users || []) {
      if (!/^lms-(?:instructor|outsider)-\d+-[a-f0-9]+@example\.test$/.test(staleUser.email || '')) {
        continue;
      }

      const staleUserCleanup = await fetch(`${supabase.API_URL}/auth/v1/admin/users/${staleUser.id}`, {
        method: 'DELETE',
        headers: {
          apikey: supabase.PUBLISHABLE_KEY,
          Authorization: `Bearer ${supabase.SERVICE_ROLE_KEY}`,
        },
      });
      assert.equal(staleUserCleanup.status, 200, 'Prior synthetic realtime Auth user cleanup should succeed');
    }

    const createUserResponse = await fetch(`${supabase.API_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: supabase.PUBLISHABLE_KEY,
        Authorization: `Bearer ${supabase.SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { display_name: 'Local Integration Learner', role: 'admin' },
      }),
    });
    if (!createUserResponse.ok) {
      const failure = await createUserResponse.json().catch(() => ({})) as { code?: unknown; error_code?: unknown };
      const code = typeof failure.code === 'string'
        ? failure.code
        : typeof failure.error_code === 'string' ? failure.error_code : 'unavailable';
      throw new Error(`Synthetic local user creation failed with HTTP ${createUserResponse.status} (${code}).`);
    }
    const createdUser = await createUserResponse.json() as { id?: string };
    userId = createdUser.id;
    assert.ok(userId, 'Supabase admin API did not return the synthetic user');
    console.log('Synthetic Supabase Auth user created.');

    const providerLogin = await fetch(`${supabase.API_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: supabase.PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!providerLogin.ok) {
      const failure = await providerLogin.json().catch(() => ({})) as { code?: unknown; error_code?: unknown };
      const code = typeof failure.code === 'string'
        ? failure.code
        : typeof failure.error_code === 'string' ? failure.error_code : 'unavailable';
      throw new Error(`Local Supabase password grant failed with HTTP ${providerLogin.status} (${code}).`);
    }
    const providerTokens = await providerLogin.json() as { access_token: string };
    await fetch(`${supabase.API_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: {
        apikey: supabase.PUBLISHABLE_KEY,
        Authorization: `Bearer ${providerTokens.access_token}`,
      },
    });

    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (loginResponse.status !== 200) {
      const failure = await loginResponse.json().catch(() => ({})) as { message?: unknown };
      const message = typeof failure.message === 'string' ? failure.message : 'no response message';
      throw new Error(`Backend login failed with HTTP ${loginResponse.status} (${message}).`);
    }
    const login = await loginResponse.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(login).sort(), ['user']);
    assert.equal((login.user as { id?: string }).id, userId);
    assert.equal(JSON.stringify(login).includes('access_token'), false);
    assert.equal(JSON.stringify(login).includes('refresh_token'), false);
    const cookie = cookiePair(loginResponse.headers.get('set-cookie'));

    const sessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Cookie: cookie },
    });
    assert.equal(sessionResponse.status, 200);
    const session = await sessionResponse.json() as { user?: { id?: string } };
    assert.equal(session.user?.id, userId);
    assert.equal(JSON.stringify(session).includes('access_token'), false);
    assert.equal(JSON.stringify(session).includes('refresh_token'), false);

    const dashboardResponse = await fetch(`${baseUrl}/api/dashboard`, {
      headers: { Cookie: cookie },
    });
    assert.equal(dashboardResponse.status, 200);
    const dashboard = await dashboardResponse.json() as { learner?: { id?: string; role?: string } };
    assert.equal(dashboard.learner?.id, userId);
    assert.equal(dashboard.learner?.role, 'learner', 'Auth metadata role must not override the profile trigger role');

    const privilegedSessionResponse = await fetch(
      `${supabase.API_URL}/rest/v1/app_sessions?user_id=eq.${userId}&select=session_hash,user_id,revoked_at`,
      { headers: { apikey: supabase.SECRET_KEY } },
    );
    assert.equal(privilegedSessionResponse.status, 200, 'Backend secret key should see the created app session');
    const privilegedSessions = await privilegedSessionResponse.json() as Array<{ user_id: string }>;
    assert.equal(privilegedSessions.length, 1);
    assert.equal(privilegedSessions[0].user_id, userId);

    const opaqueCookie = cookie.slice(cookie.indexOf('=') + 1);
    const sessionHash = createHash('sha256').update(opaqueCookie).digest('hex');
    const sessionRowUrl = `${supabase.API_URL}/rest/v1/app_sessions?session_hash=eq.${sessionHash}&select=refresh_token_ciphertext,refresh_lock_until`;
    const beforeFailedRefreshResponse = await fetch(sessionRowUrl, {
      headers: { apikey: supabase.SECRET_KEY },
    });
    const beforeFailedRefresh = await beforeFailedRefreshResponse.json() as Array<{
      refresh_token_ciphertext: string;
      refresh_lock_until: string | null;
    }>;
    assert.equal(beforeFailedRefresh.length, 1);

    const savedFetch = global.fetch;
    let failNextTokenPersistence = true;
    let failNextLockRelease = true;
    global.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method || 'GET';

      if (failNextTokenPersistence && method === 'PATCH' && url.includes('/rest/v1/app_sessions?')) {
        failNextTokenPersistence = false;
        return new Response(null, { status: 503 });
      }

      if (failNextLockRelease && url.endsWith('/rest/v1/rpc/release_app_session_refresh')) {
        failNextLockRelease = false;
        return new Response(null, { status: 503 });
      }

      return savedFetch(input, init);
    };

    let interruptedRefreshResponse: Response;

    try {
      interruptedRefreshResponse = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { Origin: origin, Cookie: cookie },
      });
    } finally {
      global.fetch = savedFetch;
    }

    assert.equal(interruptedRefreshResponse!.status, 503, 'Lost token persistence should be retryable');
    assert.equal(interruptedRefreshResponse!.headers.get('set-cookie'), null);
    const afterFailedRefreshResponse = await fetch(sessionRowUrl, {
      headers: { apikey: supabase.SECRET_KEY },
    });
    const afterFailedRefresh = await afterFailedRefreshResponse.json() as Array<{
      refresh_token_ciphertext: string;
      refresh_lock_until: string | null;
    }>;
    assert.equal(afterFailedRefresh.length, 1);
    assert.equal(afterFailedRefresh[0].refresh_token_ciphertext, beforeFailedRefresh[0].refresh_token_ciphertext);
    assert.ok(afterFailedRefresh[0].refresh_lock_until, 'Simulated process interruption must leave its refresh lease behind');

    // The configured refresh lease is 15 seconds and Supabase's local parent-token
    // reuse interval is 10 seconds. Retry only after both have elapsed.
    await delay(16000);
    const recoveredRefreshResponse = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie },
    });
    assert.equal(recoveredRefreshResponse.status, 200, 'Retrying the persisted parent token should recover the active Supabase token');
    const recoveredRefresh = await recoveredRefreshResponse.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(recoveredRefresh).sort(), ['user']);
    assert.equal(JSON.stringify(recoveredRefresh).includes('access_token'), false);
    assert.equal(JSON.stringify(recoveredRefresh).includes('refresh_token'), false);
    const recoveredCookie = cookiePair(recoveredRefreshResponse.headers.get('set-cookie'));
    const afterRecoveryResponse = await fetch(sessionRowUrl, {
      headers: { apikey: supabase.SECRET_KEY },
    });
    const afterRecovery = await afterRecoveryResponse.json() as Array<{
      refresh_token_ciphertext: string;
      refresh_lock_until: string | null;
    }>;
    assert.equal(afterRecovery.length, 1);
    assert.notEqual(afterRecovery[0].refresh_token_ciphertext, beforeFailedRefresh[0].refresh_token_ciphertext);
    assert.equal(afterRecovery[0].refresh_lock_until, null);

    const { NotificationsGateway } = await import('../src/realtime/notifications.gateway');
    const createSyntheticRealtimeUser = async (label: string): Promise<{ id: string; cookie: string }> => {
      const realtimeEmail = `lms-${label}-${Date.now()}-${randomBytes(4).toString('hex')}@example.test`;
      const realtimePassword = `LocalSmoke-${randomBytes(18).toString('base64url')}aA1!`;
      const createResponse = await fetch(`${supabase.API_URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: {
          apikey: supabase.PUBLISHABLE_KEY,
          Authorization: `Bearer ${supabase.SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: realtimeEmail,
          password: realtimePassword,
          email_confirm: true,
          user_metadata: { display_name: `Synthetic ${label}` },
        }),
      });
      if (!createResponse.ok) {
        throw new Error(`Synthetic ${label} creation failed with HTTP ${createResponse.status}.`);
      }
      const created = await createResponse.json() as { id?: string };
      assert.ok(created.id, `Supabase did not return the synthetic ${label} ID`);
      realtimeUserIds.push(created.id);

      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: realtimeEmail, password: realtimePassword }),
      });
      assert.equal(loginResponse.status, 200, `Synthetic ${label} BFF login should succeed`);
      return { id: created.id, cookie: cookiePair(loginResponse.headers.get('set-cookie')) };
    };

    const instructor = await createSyntheticRealtimeUser('instructor');
    const outsider = await createSyntheticRealtimeUser('outsider');
    const serviceHeaders = {
      apikey: supabase.SECRET_KEY,
      'Content-Type': 'application/json',
    };
    const updateInstructor = await fetch(
      `${supabase.API_URL}/rest/v1/profiles?id=eq.${instructor.id}`,
      {
        method: 'PATCH',
        headers: { ...serviceHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ role: 'instructor' }),
      },
    );
    assert.equal(updateInstructor.status, 204, 'Synthetic instructor role should be provisioned by the service key');

    const courseResponse = await fetch(`${supabase.API_URL}/rest/v1/courses?select=id`, {
      method: 'POST',
      headers: { ...serviceHeaders, Prefer: 'return=representation' },
      body: JSON.stringify({
        owner_id: instructor.id,
        title: 'Realtime Integration Course',
        description: 'Synthetic local integration data',
        category: 'Integration',
        level: 'beginner',
        status: 'published',
      }),
    });
    assert.equal(courseResponse.status, 201, 'Synthetic course provisioning should succeed');
    const courses = await courseResponse.json() as Array<{ id: string }>;
    const courseId = courses[0]?.id;
    assert.ok(courseId, 'Synthetic course creation should return an ID');
    realtimeCourseId = courseId;

    const insertEnrollment = async (enrolleeId: string) => fetch(
      `${supabase.API_URL}/rest/v1/course_enrollments`,
      {
        method: 'POST',
        headers: { ...serviceHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ course_id: courseId, user_id: enrolleeId, status: 'active' }),
      },
    );
    assert.equal((await insertEnrollment(userId)).status, 201, 'Synthetic learner enrollment should succeed');

    const learnerNotifications = await connectSocket(`${baseUrl}/notifications`, origin, recoveredCookie);
    const instructorClassroom = await connectSocket(`${baseUrl}/classroom`, origin, instructor.cookie);
    const outsiderNotifications = await connectSocket(`${baseUrl}/notifications`, origin, outsider.cookie);
    const outsiderClassroom = await connectSocket(`${baseUrl}/classroom`, origin, outsider.cookie);
    const outsiderHistoryClassroom = await connectSocket(`${baseUrl}/classroom`, origin, outsider.cookie);
    const outsiderSendClassroom = await connectSocket(`${baseUrl}/classroom`, origin, outsider.cookie);
    const learnerClassroom = await connectSocket(`${baseUrl}/classroom`, origin, recoveredCookie);
    realtimeSockets.push(
      learnerNotifications,
      instructorClassroom,
      outsiderNotifications,
      outsiderClassroom,
      outsiderHistoryClassroom,
      outsiderSendClassroom,
      learnerClassroom,
    );
    assert.equal((await learnerNotifications.timeout(5000).emitWithAck('notification:subscribe', {})).subscribed, true);
    assert.equal((await outsiderNotifications.timeout(5000).emitWithAck('notification:subscribe', {})).subscribed, true);

    const notificationEvent = waitForSocketEvent<{ id: string; user_id: string }>(learnerNotifications, 'notification:new');
    let outsiderReceivedNotification = false;
    outsiderNotifications.on('notification:new', () => { outsiderReceivedNotification = true; });
    const notificationGateway = app.get(NotificationsGateway);
    const notification = await notificationGateway.notifyUser(userId, 'integration', 'Private local notice', 'Synthetic notification scope check');
    const deliveredNotification = await notificationEvent;
    assert.equal(deliveredNotification.id, notification.id);
    assert.equal(deliveredNotification.user_id, userId);
    await delay(100);
    assert.equal(outsiderReceivedNotification, false, 'A user notification must not reach another user namespace room');

    const instructorJoin = await instructorClassroom.timeout(5000).emitWithAck('course:join', { courseId });
    assert.deepEqual(instructorJoin, { ok: true, courseId }, 'Course owner with instructor role must be authorized');
    const learnerJoin = await learnerClassroom.timeout(5000).emitWithAck('course:join', { courseId });
    assert.deepEqual(learnerJoin, { ok: true, courseId }, 'Active enrolled learner must be authorized');
    assert.deepEqual(
      await outsiderClassroom.timeout(5000).emitWithAck('course:join', { courseId }),
      { ok: false, error: 'FORBIDDEN' },
      'Non-enrolled user must be denied course room membership',
    );
    assert.equal((await outsiderHistoryClassroom.timeout(5000).emitWithAck('course:join', { courseId })).error, 'FORBIDDEN');
    assert.equal((await outsiderSendClassroom.timeout(5000).emitWithAck('course:join', { courseId })).error, 'FORBIDDEN');

    const persistedBeforeLearnerDelivery = waitForSocketEvent<{ id: string; course_id: string; sender_id: string }>(
      learnerClassroom,
      'classroom:message:new',
    ).then(async (message) => {
      const persisted = await fetch(
        `${supabase.API_URL}/rest/v1/classroom_messages?id=eq.${message.id}&select=id,course_id,sender_id`,
        { headers: { apikey: supabase.SECRET_KEY } },
      );
      assert.equal(persisted.status, 200);
      const rows = await persisted.json() as Array<{ id: string; course_id: string; sender_id: string }>;
      assert.deepEqual(rows, [{ id: message.id, course_id: courseId, sender_id: userId }]);
      return message;
    });
    const instructorMessage = waitForSocketEvent<{ id: string; sender_id: string }>(instructorClassroom, 'classroom:message:new');
    let outsiderReceivedMessage = false;
    outsiderClassroom.on('classroom:message:new', () => { outsiderReceivedMessage = true; });
    const sentMessage = await learnerClassroom.timeout(5000).emitWithAck('classroom:message:send', {
      courseId,
      body: 'Persist this synthetic message before broadcasting it.',
    });
    assert.equal(sentMessage.ok, true);
    assert.equal(sentMessage.message.sender_id, userId, 'Message sender must come from authenticated session');
    const [learnerMessage, instructorMessageResult] = await Promise.all([persistedBeforeLearnerDelivery, instructorMessage]);
    assert.equal(learnerMessage.id, sentMessage.message.id);
    assert.equal(instructorMessageResult.id, sentMessage.message.id);
    assert.equal(instructorMessageResult.sender_id, userId);
    assert.equal((await learnerClassroom.timeout(5000).emitWithAck('classroom:history:request', { courseId })).ok, true);

    assert.equal((await insertEnrollment(outsider.id)).status, 201, 'Outsider membership fixture should be provisioned');
    assert.equal((await outsiderClassroom.timeout(5000).emitWithAck('course:join', { courseId })).ok, true);
    assert.equal((await outsiderHistoryClassroom.timeout(5000).emitWithAck('course:join', { courseId })).ok, true);
    assert.equal((await outsiderSendClassroom.timeout(5000).emitWithAck('course:join', { courseId })).ok, true);
    const removeOutsiderEnrollment = await fetch(
      `${supabase.API_URL}/rest/v1/course_enrollments?course_id=eq.${courseId}&user_id=eq.${outsider.id}`,
      { method: 'DELETE', headers: { ...serviceHeaders, Prefer: 'return=minimal' } },
    );
    assert.equal(removeOutsiderEnrollment.status, 204, 'Synthetic enrollment revocation should succeed');

    assert.deepEqual(
      await outsiderHistoryClassroom.timeout(5000).emitWithAck('classroom:history:request', { courseId }),
      { ok: false, error: 'FORBIDDEN' },
      'History request must recheck current database enrollment',
    );
    assert.deepEqual(
      await outsiderSendClassroom.timeout(5000).emitWithAck('classroom:message:send', { courseId, body: 'Denied after revocation' }),
      { ok: false, error: 'FORBIDDEN' },
      'Message send must recheck current database enrollment',
    );

    let outsiderReceivedAfterRevocation = false;
    outsiderClassroom.on('classroom:message:new', () => { outsiderReceivedAfterRevocation = true; });
    const instructorSecondMessage = waitForSocketEvent(instructorClassroom, 'classroom:message:new');
    const learnerSecondMessage = waitForSocketEvent(learnerClassroom, 'classroom:message:new');
    const secondMessage = await learnerClassroom.timeout(5000).emitWithAck('classroom:message:send', {
      courseId,
      body: 'Membership is checked again before recipient delivery.',
    });
    assert.equal(secondMessage.ok, true);
    await Promise.all([instructorSecondMessage, learnerSecondMessage]);
    await delay(100);
    assert.equal(outsiderReceivedAfterRevocation, false, 'Revoked enrollment must block passive room delivery');
    const learnerSocketDisconnects = [
      waitForSocketDisconnect(learnerNotifications),
      waitForSocketDisconnect(learnerClassroom),
    ];

    const publicSessionResponse = await fetch(
      `${supabase.API_URL}/rest/v1/app_sessions?select=session_hash,user_id,access_token_ciphertext,refresh_token_ciphertext`,
      { headers: { apikey: supabase.PUBLISHABLE_KEY } },
    );
    const publicSessionBody = await publicSessionResponse.text();
    assert.ok(
      !publicSessionResponse.ok || publicSessionBody === '[]',
      `Public client unexpectedly read app_sessions (HTTP ${publicSessionResponse.status})`,
    );
    assert.equal(publicSessionBody.includes(userId), false);
    assert.equal(publicSessionBody.includes('access_token_ciphertext'), false);

    const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: recoveredCookie },
    });
    assert.equal(logoutResponse.status, 204);
    await Promise.all(learnerSocketDisconnects);
    assert.equal(learnerNotifications.connected, false, 'Logout must disconnect the notifications namespace');
    assert.equal(learnerClassroom.connected, false, 'Logout must disconnect the classroom namespace');

    const revokedSessionResponse = await fetch(
      `${supabase.API_URL}/rest/v1/app_sessions?user_id=eq.${userId}&select=revoked_at`,
      { headers: { apikey: supabase.SECRET_KEY } },
    );
    const revokedSessions = await revokedSessionResponse.json() as Array<{ revoked_at: string | null }>;
    assert.equal(revokedSessions.length, 1);
    assert.ok(revokedSessions[0].revoked_at, 'Logout must revoke the persisted application session');

    const cleanupNow = new Date();
    const expiredHash = createHash('sha256').update(randomBytes(32)).digest('hex');
    const oldRevokedHash = createHash('sha256').update(randomBytes(32)).digest('hex');
    const recentRevokedHash = createHash('sha256').update(randomBytes(32)).digest('hex');
    const expiredRecentRevokedHash = createHash('sha256').update(randomBytes(32)).digest('hex');
    const syntheticSessions = [
      {
        session_hash: expiredHash,
        user_id: userId,
        access_token_ciphertext: 'synthetic-expired-access',
        refresh_token_ciphertext: 'synthetic-expired-refresh',
        expires_at: new Date(cleanupNow.getTime() - 60 * 60 * 1000).toISOString(),
      },
      {
        session_hash: oldRevokedHash,
        user_id: userId,
        access_token_ciphertext: 'synthetic-old-revoked-access',
        refresh_token_ciphertext: 'synthetic-old-revoked-refresh',
        expires_at: new Date(cleanupNow.getTime() + 24 * 60 * 60 * 1000).toISOString(),
        revoked_at: new Date(cleanupNow.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        session_hash: recentRevokedHash,
        user_id: userId,
        access_token_ciphertext: 'synthetic-recent-revoked-access',
        refresh_token_ciphertext: 'synthetic-recent-revoked-refresh',
        expires_at: new Date(cleanupNow.getTime() + 24 * 60 * 60 * 1000).toISOString(),
        revoked_at: new Date(cleanupNow.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        session_hash: expiredRecentRevokedHash,
        user_id: userId,
        access_token_ciphertext: 'synthetic-expired-recent-revoked-access',
        refresh_token_ciphertext: 'synthetic-expired-recent-revoked-refresh',
        expires_at: new Date(cleanupNow.getTime() - 60 * 60 * 1000).toISOString(),
        revoked_at: new Date(cleanupNow.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      },
    ];
    for (const syntheticSession of syntheticSessions) {
      const insertSyntheticSession = await fetch(`${supabase.API_URL}/rest/v1/app_sessions`, {
        method: 'POST',
        headers: {
          apikey: supabase.SECRET_KEY,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(syntheticSession),
      });
      if (!insertSyntheticSession.ok) {
        const failure = await insertSyntheticSession.json().catch(() => ({})) as { code?: unknown };
        const code = typeof failure.code === 'string' ? failure.code : 'unavailable';
        throw new Error(`Synthetic retention fixture failed with HTTP ${insertSyntheticSession.status} (${code}).`);
      }
    }

    const { AuthService } = await import('../src/auth/auth.service');
    await app.get(AuthService).cleanupStaleSessions(cleanupNow);
    const remainingSessionsResponse = await fetch(
      `${supabase.API_URL}/rest/v1/app_sessions?user_id=eq.${userId}&select=session_hash`,
      { headers: { apikey: supabase.SECRET_KEY } },
    );
    assert.equal(remainingSessionsResponse.status, 200);
    const remainingSessions = await remainingSessionsResponse.json() as Array<{ session_hash: string }>;
    assert.deepEqual(
      remainingSessions.map(({ session_hash }) => session_hash).sort(),
      [sessionHash, recentRevokedHash, expiredRecentRevokedHash].sort(),
      'Cleanup must remove expired non-revoked and old-revoked rows but retain all recent revocations',
    );

    console.log('Local Supabase integration passed: BFF auth/session lifecycle, profile role protection, public app_sessions denial, refresh recovery, retention cleanup, real namespace separation, course ACLs, current membership revocation, notification scoping, persisted-before-delivery messages, and logout disconnect.');
  } finally {
    realtimeSockets.forEach((socket) => socket.disconnect());
    if (realtimeCourseId) {
      const courseCleanupResponse = await fetch(
        `${supabase.API_URL}/rest/v1/courses?id=eq.${realtimeCourseId}`,
        {
          method: 'DELETE',
          headers: { apikey: supabase.SECRET_KEY, Prefer: 'return=minimal' },
        },
      ).catch(() => undefined);

      if (!courseCleanupResponse?.ok) {
        console.error(`Synthetic realtime course cleanup failed (HTTP ${courseCleanupResponse?.status || 'network error'}).`);
        process.exitCode = 1;
      }
    }

    for (const realtimeUserId of realtimeUserIds) {
      const cleanupResponse = await fetch(`${supabase.API_URL}/auth/v1/admin/users/${realtimeUserId}`, {
        method: 'DELETE',
        headers: {
          apikey: supabase.PUBLISHABLE_KEY,
          Authorization: `Bearer ${supabase.SERVICE_ROLE_KEY}`,
        },
      }).catch(() => undefined);

      if (!cleanupResponse?.ok) {
        console.error(`Synthetic realtime Auth user cleanup failed (HTTP ${cleanupResponse?.status || 'network error'}).`);
        process.exitCode = 1;
      }
    }

    if (userId) {
      const cleanupResponse = await fetch(`${supabase.API_URL}/auth/v1/admin/users/${userId}`, {
        method: 'DELETE',
        headers: {
          apikey: supabase.PUBLISHABLE_KEY,
          Authorization: `Bearer ${supabase.SERVICE_ROLE_KEY}`,
        },
      }).catch(() => undefined);

      if (!cleanupResponse?.ok) {
        console.error(`Synthetic Auth user cleanup failed (HTTP ${cleanupResponse?.status || 'network error'}).`);
        process.exitCode = 1;
      } else {
        console.log('Synthetic Supabase Auth user deleted.');
      }
    }

    await app.close();
  }
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown integration smoke failure';
  console.error(`Local Supabase integration failed: ${message}`);
  process.exitCode = 1;
});
