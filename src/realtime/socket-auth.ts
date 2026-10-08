import { Namespace, Socket } from 'socket.io';
import { loadConfig } from '../config';
import { AuthService, AuthenticatedUser } from '../auth/auth.service';
import { SESSION_COOKIE } from '../auth/auth.controller';

export type AuthenticatedSocket = Socket & { data: { user: AuthenticatedUser; sessionHash: string } };

export function socketOptions(namespace: string) {
  const origins = loadConfig(process.env).frontendOrigins;

  return {
    namespace,
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
  namespace.use((socket, next) => {
    void (async () => {
      try {
        assertSocketOrigin(socket);
        const cookie = socketCookie(socket);

        if (!cookie) {
          throw new Error('Authentication required');
        }

        const user = await authService.getAuthenticatedUser(cookie);

        if (!user) {
          throw new Error('Authentication required');
        }

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
