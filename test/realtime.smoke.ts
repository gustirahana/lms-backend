import 'dotenv/config';
import * as assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import { io, Socket } from 'socket.io-client';
import { loadConfig } from '../src/config';
import { ApiRateLimitMiddleware } from '../src/security/rate-limit.middleware';
import { originCheck } from '../src/security/origin-check.middleware';
import { securityHeaders } from '../src/security/security-headers.middleware';

const origin = 'http://localhost:5173';
const allowedCourse = '11111111-1111-4111-8111-111111111111';
const deniedCourse = '22222222-2222-4222-8222-222222222222';
const learnerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const outsiderId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const recipientId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const sessionHash = 'hash-for-smoke-session';
const outsiderSessionHash = 'hash-for-outsider-session';
const recipientSessionHash = 'hash-for-recipient-session';

interface SmokeMessage {
  id: string;
  course_id: string;
  sender_id: string;
  body: string;
  created_at: string;
}

function waitForConnect(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
    socket.connect();
  });
}

async function expectRejected(url: string, headers: Record<string, string>): Promise<void> {
  const socket = io(url, { transports: ['websocket'], forceNew: true, autoConnect: false, extraHeaders: headers, timeout: 2000 });
  try {
    await assert.rejects(waitForConnect(socket));
  } finally {
    socket.disconnect();
  }
}

function disconnected(socket: Socket): Promise<unknown> {
  if (!socket.connected) {
    return Promise.resolve();
  }
  return new Promise((resolve) => socket.once('disconnect', resolve));
}

async function run(): Promise<void> {
  process.env.NODE_ENV = 'test';
  process.env.FRONTEND_ORIGINS = origin;
  const [{ AppModule }, { AuthService }, { NotificationsGateway }] = await Promise.all([
    import('../src/app.module'),
    import('../src/auth/auth.service'),
    import('../src/realtime/notifications.gateway'),
  ]);
  const persistedMessages: SmokeMessage[] = [];
  const users = {
    'smoke-session': { id: learnerId, email: 'learner@example.test' },
    'outsider-session': { id: outsiderId, email: 'outsider@example.test' },
    'recipient-session': { id: recipientId, email: 'recipient@example.test' },
  };
  const hashes: Record<string, string> = {
    'smoke-session': sessionHash,
    'outsider-session': outsiderSessionHash,
    'recipient-session': recipientSessionHash,
  };
  const activeSessions = new Set([sessionHash, outsiderSessionHash, recipientSessionHash]);
  let recipientCourseMember = true;
  const authMock = {
    login: async () => ({
      cookie: 'smoke-session',
      cookieMaxAgeMs: 3600000,
      user: users['smoke-session'],
    }),
    getAuthenticatedUser: async (cookie: string) => users[cookie as keyof typeof users] || null,
    sessionHashForCookie: (cookie: string) => hashes[cookie],
    isSessionActive: async (hash: string) => activeSessions.has(hash),
    canJoinCourse: async (userId: string, courseId: string) =>
      courseId === allowedCourse && (userId === learnerId || (userId === recipientId && recipientCourseMember)),
    getUnreadNotifications: async (userId: string) => [{ id: 'notice-1', user_id: userId, title: 'Welcome' }],
    createNotification: async (userId: string, type: string, title: string, body: string) => ({
      id: 'notice-new', user_id: userId, type, title, body, read_at: null, created_at: new Date().toISOString(),
    }),
    markNotificationRead: async () => true,
    getCourseMessages: async () => persistedMessages,
    createClassroomMessage: async (userId: string, courseId: string, body: string) => {
      const message = {
        id: `message-${persistedMessages.length + 1}`,
        course_id: courseId,
        sender_id: userId,
        body,
        created_at: new Date().toISOString(),
      };
      persistedMessages.push(message);
      return message;
    },
    logout: async (cookie: string) => {
      const hash = hashes[cookie];
      activeSessions.delete(hash);
      return hash;
    },
    checkDatabaseReadiness: async () => true,
  };

  const config = loadConfig(process.env);
  // Replace the live Supabase-backed provider before Nest initializes gateways.
  const testingModule = await import('@nestjs/testing');
  const moduleRef = await testingModule.Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(AuthService)
    .useValue(authMock)
    .compile();
  const smokeApp = moduleRef.createNestApplication({ bodyParser: false, logger: false });
  smokeApp.setGlobalPrefix('api');
  smokeApp.getHttpAdapter().getInstance().set('trust proxy', config.trustProxyHops);
  smokeApp.use(securityHeaders(false));
  smokeApp.use(json({ limit: config.bodyLimit }));
  smokeApp.use(urlencoded({ extended: false, limit: config.bodyLimit }));
  smokeApp.use(originCheck(config.frontendOrigins));
  smokeApp.use(new ApiRateLimitMiddleware(1000, 60000, 1000, 60000).use);
  smokeApp.enableCors({
    origin: config.frontendOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-App-Name', 'X-App-Version', 'X-App-Device'],
    credentials: true,
  });

  await smokeApp.listen(0, '127.0.0.1');
  const address = smokeApp.getHttpServer().address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const notificationUrl = `${baseUrl}/notifications`;
  const classroomUrl = `${baseUrl}/classroom`;
  const cookie = 'lms_session=smoke-session';
  const primaryHeaders = { Origin: origin, Cookie: cookie };
  const clients: Socket[] = [];

  try {
    const rejectedLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'learner@example.test', password: 'synthetic-password' }),
    });
    assert.equal(rejectedLogin.status, 403);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'learner@example.test', password: 'synthetic-password' }),
    });
    assert.equal(login.status, 200);
    assert.deepEqual(await login.json(), { user: users['smoke-session'] });
    const loginCookie = login.headers.get('set-cookie') || '';
    assert.match(loginCookie, /^lms_session=smoke-session;/);
    assert.match(loginCookie, /; HttpOnly;/i);
    assert.match(loginCookie, /; SameSite=Lax/i);

    const invalidLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'learner@example.test', password: 'synthetic-password', role: 'admin' }),
    });
    assert.equal(invalidLogin.status, 400);

    await expectRejected(notificationUrl, { Origin: 'http://evil.example', Cookie: cookie });
    await expectRejected(classroomUrl, { Cookie: cookie });
    await expectRejected(classroomUrl, { Origin: origin, Cookie: 'lms_session=unknown-session' });

    const notifications = io(notificationUrl, { transports: ['websocket'], forceNew: true, autoConnect: false, extraHeaders: primaryHeaders });
    const classroom = io(classroomUrl, { transports: ['websocket'], forceNew: true, autoConnect: false, extraHeaders: primaryHeaders });
    clients.push(notifications, classroom);
    await Promise.all([waitForConnect(notifications), waitForConnect(classroom)]);
    assert.equal((notifications as unknown as { nsp: string }).nsp, '/notifications');
    assert.equal((classroom as unknown as { nsp: string }).nsp, '/classroom');

    const notificationAck = await notifications.timeout(2000).emitWithAck('notification:subscribe', {});
    assert.equal(notificationAck.subscribed, true);
    assert.equal(notificationAck.notifications[0].user_id, learnerId);

    const denied = await classroom.timeout(2000).emitWithAck('course:join', { courseId: deniedCourse });
    assert.deepEqual(denied, { ok: false, error: 'FORBIDDEN' });
    const joined = await classroom.timeout(2000).emitWithAck('course:join', { courseId: allowedCourse });
    assert.deepEqual(joined, { ok: true, courseId: allowedCourse });

    const outsider = io(classroomUrl, {
      transports: ['websocket'],
      forceNew: true,
      autoConnect: false,
      extraHeaders: { Origin: origin, Cookie: 'lms_session=outsider-session' },
    });
    clients.push(outsider);
    await waitForConnect(outsider);
    const outsiderJoin = await outsider.timeout(2000).emitWithAck('course:join', { courseId: allowedCourse });
    assert.deepEqual(outsiderJoin, { ok: false, error: 'FORBIDDEN' });

    const recipientNotifications = io(notificationUrl, {
      transports: ['websocket'], forceNew: true, autoConnect: false,
      extraHeaders: { Origin: origin, Cookie: 'lms_session=recipient-session' },
    });
    const recipientClassroom = io(classroomUrl, {
      transports: ['websocket'], forceNew: true, autoConnect: false,
      extraHeaders: { Origin: origin, Cookie: 'lms_session=recipient-session' },
    });
    clients.push(recipientNotifications, recipientClassroom);
    await Promise.all([waitForConnect(recipientNotifications), waitForConnect(recipientClassroom)]);
    const recipientSubscribe = await recipientNotifications.timeout(2000).emitWithAck('notification:subscribe', {});
    assert.equal(recipientSubscribe.subscribed, true);
    assert.equal((await recipientClassroom.timeout(2000).emitWithAck('course:join', { courseId: allowedCourse })).ok, true);

    let observedPersistedAtBroadcast = false;
    let recipientMessageCount = 0;
    const firstRecipientMessage = new Promise<void>((resolve) => {
      recipientClassroom.once('classroom:message:new', () => {
        recipientMessageCount += 1;
        resolve();
      });
    });
    classroom.once('classroom:message:new', (message: SmokeMessage) => {
      observedPersistedAtBroadcast = persistedMessages.some((row) => row.id === message.id);
    });
    const sent = await classroom.timeout(2000).emitWithAck('classroom:message:send', {
      courseId: allowedCourse,
      body: 'Persist before broadcast',
    });
    assert.equal(sent.ok, true);
    assert.equal(sent.message.sender_id, learnerId);
    assert.equal(observedPersistedAtBroadcast, true);
    await firstRecipientMessage;
    recipientClassroom.on('classroom:message:new', () => { recipientMessageCount += 1; });

    recipientCourseMember = false;
    const afterEnrollmentRevoked = await classroom.timeout(2000).emitWithAck('classroom:message:send', {
      courseId: allowedCourse,
      body: 'Recipient enrollment was revoked',
    });
    assert.equal(afterEnrollmentRevoked.ok, true);
    assert.equal(recipientMessageCount, 1);

    recipientCourseMember = true;
    assert.equal((await recipientClassroom.timeout(2000).emitWithAck('course:join', { courseId: allowedCourse })).ok, true);
    let receivedAfterSessionRevoked = false;
    let receivedRevokedNotification = false;
    recipientClassroom.once('classroom:message:new', () => { receivedAfterSessionRevoked = true; });
    recipientNotifications.on('notification:new', () => { receivedRevokedNotification = true; });
    const recipientNotificationDisconnect = disconnected(recipientNotifications);
    activeSessions.delete(recipientSessionHash);
    const notificationGateway = smokeApp.get(NotificationsGateway);
    await notificationGateway.notifyUser(recipientId, 'system', 'Session check', 'Private notification');
    await recipientNotificationDisconnect;
    assert.equal(receivedRevokedNotification, false);

    const recipientClassroomDisconnect = disconnected(recipientClassroom);
    const afterSessionRevoked = await classroom.timeout(2000).emitWithAck('classroom:message:send', {
      courseId: allowedCourse,
      body: 'Recipient session was revoked',
    });
    assert.equal(afterSessionRevoked.ok, true);
    await recipientClassroomDisconnect;
    assert.equal(receivedAfterSessionRevoked, false);

    const primaryDisconnects = [disconnected(notifications), disconnected(classroom)];
    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie },
    });
    assert.equal(logout.status, 204);
    await Promise.all(primaryDisconnects);
    assert.equal(notifications.connected, false);
    assert.equal(classroom.connected, false);

    console.log('Realtime smoke passed: namespace separation, origin/session rejection, notifications, course ACL, recipient revocation, persistence ordering, logout disconnect.');
  } finally {
    clients.forEach((client) => client.disconnect());
    await smokeApp.close();
    await moduleRef.close();
  }
}

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
