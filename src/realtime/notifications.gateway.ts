import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Namespace } from 'socket.io';
import { AuthService, NotificationRecord } from '../auth/auth.service';
import { SessionSocketRegistry } from '../auth/session-socket.registry';
import {
  AuthenticatedSocket,
  installSocketAuthentication,
  isSocketSessionActive,
  socketOptions,
} from './socket-auth';

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

@WebSocketGateway(socketOptions('/notifications'))
export class NotificationsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  namespace!: Namespace;

  constructor(
    private readonly authService: AuthService,
    private readonly sessionSocketRegistry: SessionSocketRegistry,
  ) {}

  afterInit(namespace: Namespace): void {
    installSocketAuthentication(namespace, this.authService);
  }

  handleConnection(socket: AuthenticatedSocket): void {
    const user = socket.data.user;

    if (!user) {
      socket.disconnect(true);
      return;
    }

    this.sessionSocketRegistry.add(socket.data.sessionHash, socket);
    void socket.join(`user:${user.id}`);
  }

  handleDisconnect(socket: AuthenticatedSocket): void {
    if (socket.data.sessionHash) {
      this.sessionSocketRegistry.remove(socket.data.sessionHash, socket);
    }
  }

  @SubscribeMessage('notification:subscribe')
  async subscribe(@ConnectedSocket() socket: AuthenticatedSocket) {
    const user = socket.data.user;

    if (!user) {
      return { subscribed: false, notifications: [] };
    }

    if (!(await isSocketSessionActive(socket, this.authService))) {
      return { subscribed: false, notifications: [] };
    }

    const notifications = await this.authService.getUnreadNotifications(user.id);
    return { subscribed: true, notifications };
  }

  @SubscribeMessage('notification:read')
  async markRead(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() payload: { notificationId?: unknown },
  ) {
    const user = socket.data.user;

    if (!isUuid(payload?.notificationId)) {
      return { ok: false, error: 'INVALID_NOTIFICATION_ID' };
    }

    if (!(await isSocketSessionActive(socket, this.authService))) {
      return { ok: false, error: 'UNAUTHORIZED' };
    }

    const marked = await this.authService.markNotificationRead(user.id, payload.notificationId);

    if (!marked) {
      return { ok: false, error: 'NOT_FOUND' };
    }

    const event = { id: payload.notificationId, readAt: new Date().toISOString() };
    await this.emitToActiveUserSockets(user.id, 'notification:read', event);

    return { ok: true, ...event };
  }

  async notifyUser(userId: string, type: string, title: string, body: string): Promise<NotificationRecord> {
    const notification = await this.authService.createNotification(
      userId,
      type.slice(0, 64),
      title.slice(0, 200),
      body.slice(0, 2000),
    );
    await this.emitToActiveUserSockets(userId, 'notification:new', notification);

    return notification;
  }

  private async emitToActiveUserSockets(userId: string, eventName: string, payload: unknown): Promise<void> {
    const room = `user:${userId}`;
    const sockets = await this.namespace.in(room).fetchSockets();

    await Promise.all(sockets.map(async (socket) => {
      const user = socket.data.user as { id?: string } | undefined;
      const sessionHash = socket.data.sessionHash as string | undefined;

      if (!user || user.id !== userId || !sessionHash) {
        socket.disconnect(true);
        return;
      }

      if (!(await this.authService.isSessionActive(sessionHash, userId))) {
        socket.disconnect(true);
        return;
      }

      this.namespace.to(socket.id).emit(eventName, payload);
    }));
  }
}
