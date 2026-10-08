import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';

const authUser = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'learner@example.test',
  user_metadata: { role: 'admin', display_name: 'Test Learner' },
};
const accessToken = 'synthetic-access-token-not-a-real-secret';
const refreshToken = 'synthetic-refresh-token-not-a-real-secret';
const rotatedAccessToken = 'synthetic-rotated-access-token';
const rotatedRefreshToken = 'synthetic-rotated-refresh-token';
const otherUser = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', email: 'other@example.test' };

async function run(): Promise<void> {
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'https://supabase.example.test';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_synthetic';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_synthetic';
  process.env.AUTH_ENCRYPTION_KEY_VERSION = 'v1';
  process.env.AUTH_ENCRYPTION_KEYS = `v1:${Buffer.alloc(32, 7).toString('base64')}`;

  const savedFetch = global.fetch;
  let storedSession: Record<string, unknown> | undefined;
  let sessionReadQueue: Record<string, unknown>[] = [];
  let profileBody: Record<string, unknown> | undefined;
  let logoutRevokedSession = false;
  let identityMismatchRevokedSession = false;
  let claimRefreshLock = true;
  let rotatedTokenUser: { id: string; email: string; user_metadata?: { role?: string; display_name?: string } } = authUser;
  let failSessionInsert = false;
  let providerLogoutCount = 0;
  let sessionCleanupRequest: { url: string; method: string; prefer: string | null } | undefined;

  global.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;

    if (url.includes('/auth/v1')) {
      assert.equal(headers.get('apikey'), 'sb_publishable_synthetic');
    }
    if (url.includes('/rest/v1')) {
      assert.equal(headers.get('apikey'), 'sb_secret_synthetic');
      assert.equal(headers.get('Authorization'), null);
    }

    if (url.includes('/auth/v1/token?grant_type=password') && method === 'POST') {
      return Response.json({ access_token: accessToken, refresh_token: refreshToken, expires_in: 3600, user: authUser });
    }

    if (url.includes('/auth/v1/user') && method === 'GET') {
      const authorization = new Headers(init.headers).get('Authorization');
      if (!authorization?.startsWith('Bearer ')) throw new Error('Expected user access token in Authorization header');
      const token = authorization.slice('Bearer '.length);
      if (token === accessToken) return Response.json(authUser);
      if (token === rotatedAccessToken) return Response.json(rotatedTokenUser);
      return Response.json({ code: 403, msg: 'invalid JWT: token is malformed' }, { status: 403 });
    }

    if (url.includes('/auth/v1/token?grant_type=refresh_token') && method === 'POST') {
      return Response.json({
        access_token: rotatedAccessToken,
        refresh_token: rotatedRefreshToken,
        expires_in: 3600,
        user: authUser,
      });
    }

    if (url.endsWith('/auth/v1/logout') && method === 'POST') {
      providerLogoutCount += 1;
      return new Response(null, { status: 204 });
    }

    if (url.includes('/rest/v1/profiles?on_conflict=id') && method === 'POST') {
      profileBody = body;
      return new Response(null, { status: 204 });
    }

    if (url.includes('/rest/v1/app_sessions') && method === 'POST') {
      if (failSessionInsert) {
        failSessionInsert = false;
        return new Response(null, { status: 500 });
      }
      storedSession = body;
      return new Response(null, { status: 204 });
    }

    if (url.includes('/rest/v1/app_sessions') && method === 'DELETE') {
      sessionCleanupRequest = {
        url,
        method,
        prefer: headers.get('Prefer'),
      };
      return new Response(null, { status: 204 });
    }

    if (url.includes('/rest/v1/app_sessions') && method === 'GET') {
      const expectedHash = storedSession?.session_hash;
      const queued = sessionReadQueue.shift();
      const rows = expectedHash && storedSession?.revoked_at == null && url.includes(`session_hash=eq.${expectedHash}`)
        ? [queued || storedSession]
        : [];
      return Response.json(rows);
    }

    if (url.endsWith('/rest/v1/rpc/claim_app_session_refresh') && method === 'POST') {
      if (!claimRefreshLock) return Response.json(false);
      if (storedSession) {
        storedSession.refresh_lock_id = body?.p_lock_id;
        storedSession.refresh_lock_until = new Date(Date.now() + 15000).toISOString();
      }
      return Response.json(true);
    }

    if (url.endsWith('/rest/v1/rpc/release_app_session_refresh') && method === 'POST') {
      if (storedSession && storedSession.refresh_lock_id === body?.p_lock_id) {
        storedSession.refresh_lock_id = null;
        storedSession.refresh_lock_until = null;
      }
      return new Response(null, { status: 204 });
    }

    if (url.includes('/rest/v1/app_sessions') && method === 'PATCH') {
      if (body?.revoked_at) {
        logoutRevokedSession = true;
        if (storedSession) storedSession.revoked_at = body.revoked_at;
        if (body.revoked_at && rotatedTokenUser === otherUser) identityMismatchRevokedSession = true;
      } else if (storedSession) {
        storedSession = { ...storedSession, ...body };
      }
      if (new Headers(init.headers).get('Prefer')?.includes('return=representation')) {
        return Response.json(storedSession ? [storedSession] : []);
      }
      return new Response(null, { status: 204 });
    }

    throw new Error(`Unexpected mocked Supabase request: ${method} ${url}`);
  };

  try {
    const { AuthService, SessionRefreshInProgressException } = await import('../src/auth/auth.service');
    const authService = new AuthService();
    const session = await authService.login(authUser.email!, 'synthetic-password');

    assert.match(session.cookie, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(session.cookie, accessToken);
    assert.deepEqual(profileBody, {
      id: authUser.id,
      display_name: 'Test Learner',
      role: 'learner',
    });
    assert.ok(storedSession);
    assert.equal(storedSession.session_hash, createHash('sha256').update(session.cookie).digest('hex'));
    assert.notEqual(storedSession.access_token_ciphertext, accessToken);
    assert.notEqual(storedSession.refresh_token_ciphertext, refreshToken);
    assert.match(String(storedSession.access_token_ciphertext), /^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    assert.match(String(storedSession.refresh_token_ciphertext), /^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);

    await authService.cleanupStaleSessions(new Date('2026-10-08T12:00:00.000Z'));
    assert.equal(sessionCleanupRequest?.method, 'DELETE');
    assert.equal(sessionCleanupRequest?.prefer, 'return=minimal');
    const cleanupFilter = new URL(sessionCleanupRequest!.url).searchParams.get('or');
    assert.match(cleanupFilter || '', /revoked_at\.is\.null/);
    assert.match(cleanupFilter || '', /expires_at\.lt\.2026-10-08T12:00:00\.000Z/);
    assert.match(cleanupFilter || '', /revoked_at\.not\.is\.null/);
    assert.match(cleanupFilter || '', /revoked_at\.lt\.2026-09-08T12:00:00\.000Z/);

    failSessionInsert = true;
    await assert.rejects(authService.login(authUser.email!, 'synthetic-password'), /Session storage is unavailable/);
    assert.equal(providerLogoutCount, 1);

    const restoredUser = await authService.getAuthenticatedUser(session.cookie);
    assert.deepEqual(restoredUser, { id: authUser.id, email: authUser.email });

    const verifyAccessToken = Reflect.get(authService, 'verifyAccessToken') as (token: string) => Promise<unknown>;
    assert.equal(await verifyAccessToken.call(authService, 'synthetic-malformed-access-token'), undefined);

    claimRefreshLock = false;
    await assert.rejects(authService.refresh(session.cookie), SessionRefreshInProgressException);
    claimRefreshLock = true;

    const previousSession = { ...storedSession! };
    const rotated = await authService.refresh(session.cookie);
    assert.deepEqual(rotated.user, { id: authUser.id, email: authUser.email });
    const updatedSession = { ...storedSession! };
    claimRefreshLock = false;
    sessionReadQueue = [previousSession, updatedSession];
    rotatedTokenUser = otherUser;
    await assert.rejects(authService.refresh(session.cookie), (error: unknown) =>
      error instanceof Error && error.message === 'Session identity changed during refresh');
    assert.equal(identityMismatchRevokedSession, true);

    rotatedTokenUser = authUser;
    logoutRevokedSession = false;
    const replacementSession = await authService.login(authUser.email!, 'synthetic-password');

    process.env.NODE_ENV = 'production';
    process.env.FRONTEND_ORIGINS = 'https://lms.example.test';
    const { AuthController, SESSION_COOKIE } = await import('../src/auth/auth.controller');
    let retryAfter: string | undefined;
    let clearedCookie = false;
    const busyController = new AuthController(
      { refresh: async () => { throw new SessionRefreshInProgressException(); } } as never,
      { disconnectSession: () => undefined } as never,
    );
    const refreshRequest = {
      get: () => 'https://lms.example.test',
      headers: { cookie: `${SESSION_COOKIE}=${replacementSession.cookie}` },
    } as unknown as Request;
    const refreshResponse = {
      setHeader: (_name: string, value: string) => { retryAfter = value; },
      clearCookie: () => { clearedCookie = true; },
    } as unknown as Response;
    await assert.rejects(busyController.refresh(refreshRequest, refreshResponse), SessionRefreshInProgressException);
    assert.equal(retryAfter, '1');
    assert.equal(clearedCookie, false);

    await authService.logout(replacementSession.cookie);
    assert.equal(logoutRevokedSession, true);

    let issuedCookie: { name: string; value: string; options: Record<string, unknown> } | undefined;
    const controller = new AuthController(
      {
        login: async () => ({ cookie: 'synthetic-production-session', cookieMaxAgeMs: 3600000, user: { id: authUser.id, email: authUser.email } }),
      } as never,
      { disconnectSession: () => undefined } as never,
    );
    const request = {
      get: () => 'https://lms.example.test',
      body: { email: authUser.email, password: 'synthetic-password' },
    } as unknown as Request;
    const response = {
      cookie: (name: string, value: string, options: Record<string, unknown>) => {
        issuedCookie = { name, value, options };
      },
    } as unknown as Response;

    await controller.login(request, response);
    assert.equal(SESSION_COOKIE, '__Host-lms_session');
    assert.equal(issuedCookie?.name, '__Host-lms_session');
    assert.equal(issuedCookie?.options.secure, true);
    assert.equal(issuedCookie?.options.httpOnly, true);
    assert.equal(issuedCookie?.options.sameSite, 'lax');
    assert.equal(issuedCookie?.options.path, '/');

    console.log('Auth-session smoke passed: opaque cookie, SHA-256 lookup, encrypted tokens, learner role, session restore, refresh contention and identity checks, logout revocation, production cookie flags.');
  } finally {
    global.fetch = savedFetch;
  }
}

void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
