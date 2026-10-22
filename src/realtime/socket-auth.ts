import { Namespace, Socket } from 'socket.io';
import { loadConfig } from '../config';
import { AuthService, AuthenticatedUser } from '../auth/auth.service';
import { SESSION_COOKIE } from '../auth/auth.controller';

export type AuthenticatedSocket = Socket & { data: { user: AuthenticatedUser; sessionHash: string } };

export function socketOptions(namespace: string) {
  const origins = loadConfig(process.env).frontendOrigins;

  return {
    namespace,
    maxHttpBufferSize: 16384,
    connectTimeout: 10000,
    perMessageDeflate: false,
    cors: {
      origin: (origin, callback) => callback(null, Boolean(origin && origins.includes(origin))),
      credentials: true,
    },
    allowRequest: (request, callback) => {
      const origin = request.headers.origin;
      callback(null, typeof origin === 'string' && origins.includes(origin));
    },
  };
}

export function assertSocketOrigin(socket: Socket): void {
  const origins = loadConfig(process.env).frontendOrigins;
  const origin = socket.handshake.headers.origin;

  if (typeof origin !== 'string' || !origins.includes(origin)) {
    throw new Error('Origin is not allowed');
  }
}

export function socketCookie(socket: Socket): string | undefined {
  const cookieHeader = socket.handshake.headers.cookie;

  if (!cookieHeader) {
    return undefined;
  }

  const item = cookieHeader
    .split(';')
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));

  if (!item) {
    return undefined;
  }

  try {
    return decodeURIComponent(item.slice(SESSION_COOKIE.length + 1));
  } catch {
    return undefined;
  }
}

export function installSocketAuthentication(namespace: Namespace, authService: AuthService): void {
  const attempts = new Map<string, { count: number; expiresAt: number }>();
  namespace.use((socket, next) => {
    void (async () => {
      try {
        assertSocketOrigin(socket);
        const cookie = socketCookie(socket);

        if (!cookie) {
          throw new Error('Authentication required');
        }

        const now = Date.now();
        for (const [key, value] of attempts) {
          if (value.expiresAt <= now) attempts.delete(key);
        }
        const attemptKey = authService.sessionHashForCookie(cookie);
        let attempt = attempts.get(attemptKey);
        if (!attempt) {
          if (attempts.size >= 10000) throw new Error('Too many connections');
          attempt = { count: 0, expiresAt: now + 60000 };
          attempts.set(attemptKey, attempt);
        }
        if (++attempt.count > 30) throw new Error('Too many connections');
        const user = await authService.getAuthenticatedUser(cookie);

        if (!user) {
          throw new Error('Authentication required');
        }

        const sessionHash = authService.sessionHashForCookie(cookie);
        const sessionSockets = [...namespace.sockets.values()].filter(
          (other) => other.data.sessionHash === sessionHash,
        );
        if (sessionSockets.length >= 6) throw new Error('Too many connections');
        let count = 0;
        let resetsAt = Date.now() + 10000;
        socket.use((_packet, nextPacket) => {
          const now = Date.now();
          if (now >= resetsAt) { count = 0; resetsAt = now + 10000; }
          count += 1;
          if (count > 30) {
            socket.disconnect(true);
            nextPacket(new Error('Too many events'));
            return;
          }
          nextPacket();
        });
        socket.data.user = user;
        socket.data.sessionHash = authService.sessionHashForCookie(cookie);
        next();
      } catch {
        next(new Error('Unauthorized'));
      }
    })();
  });
}

export async function isSocketSessionActive(socket: AuthenticatedSocket, authService: AuthService): Promise<boolean> {
  const user = socket.data.user;
  const sessionHash = socket.data.sessionHash;

  if (!user || !sessionHash || !(await authService.isSessionActive(sessionHash, user.id))) {
    socket.disconnect(true);
    return false;
  }

  return true;
}
