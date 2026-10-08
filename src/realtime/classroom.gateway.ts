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
import { ForbiddenException } from '@nestjs/common';
import { Namespace } from 'socket.io';
import { AuthService, ClassroomMessage } from '../auth/auth.service';
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

function courseRoom(courseId: string): string {
  return `course:${courseId}`;
}

@WebSocketGateway(socketOptions('/classroom'))
export class ClassroomGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly messageWindows = new Map<string, { count: number; resetsAt: number }>();

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
    if (socket.data.sessionHash) {
      this.sessionSocketRegistry.add(socket.data.sessionHash, socket);
    }
  }

  @SubscribeMessage('course:join')
  async joinCourse(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() payload: { courseId?: unknown },
  ) {
    const user = socket.data.user;

    if (!isUuid(payload?.courseId)) {
      return { ok: false, error: 'INVALID_COURSE_ID' };
    }

    if (!(await isSocketSessionActive(socket, this.authService))) {
      return { ok: false, error: 'UNAUTHORIZED' };
    }

    if (!(await this.authService.canJoinCourse(user.id, payload.courseId))) {
      return { ok: false, error: 'FORBIDDEN' };
    }

    await socket.join(courseRoom(payload.courseId));
    return { ok: true, courseId: payload.courseId };
  }

  @SubscribeMessage('course:leave')
  async leaveCourse(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() payload: { courseId?: unknown },
  ) {
    if (!isUuid(payload?.courseId)) {
      return { ok: false, error: 'INVALID_COURSE_ID' };
    }

    await socket.leave(courseRoom(payload.courseId));
    return { ok: true, courseId: payload.courseId };
  }

  handleDisconnect(socket: AuthenticatedSocket): void {
    if (socket.data.sessionHash) {
      this.sessionSocketRegistry.remove(socket.data.sessionHash, socket);
    }
  }

  @SubscribeMessage('classroom:history:request')
  async getHistory(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() payload: { courseId?: unknown },
  ) {
    const user = socket.data.user;

    if (!isUuid(payload?.courseId) || !socket.rooms.has(courseRoom(payload.courseId))) {
      return { ok: false, error: 'COURSE_ROOM_REQUIRED' };
    }

    if (!(await isSocketSessionActive(socket, this.authService))) {
      return { ok: false, error: 'UNAUTHORIZED' };
    }

    if (!(await this.authService.canJoinCourse(user.id, payload.courseId))) {
      await socket.leave(courseRoom(payload.courseId));
      return { ok: false, error: 'FORBIDDEN' };
    }

    const messages = await this.authService.getCourseMessages(payload.courseId, 50);
    return { ok: true, messages };
  }

  @SubscribeMessage('classroom:message:send')
  async sendMessage(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() payload: { courseId?: unknown; body?: unknown },
  ) {
    const user = socket.data.user;
    const body = typeof payload?.body === 'string' ? payload.body.trim() : '';

    if (!isUuid(payload?.courseId) || body.length < 1 || body.length > 4000) {
      return { ok: false, error: 'INVALID_MESSAGE' };
    }

    if (!(await isSocketSessionActive(socket, this.authService))) {
      return { ok: false, error: 'UNAUTHORIZED' };
    }

    const room = courseRoom(payload.courseId);

    if (!socket.rooms.has(room)) {
      return { ok: false, error: 'COURSE_ROOM_REQUIRED' };
    }

    if (!(await this.authService.canJoinCourse(user.id, payload.courseId))) {
      await socket.leave(room);
      return { ok: false, error: 'FORBIDDEN' };
    }

    const now = Date.now();
    let messageWindow = this.messageWindows.get(user.id);

    if (!messageWindow || messageWindow.resetsAt <= now) {
      messageWindow = { count: 0, resetsAt: now + 60000 };
      this.messageWindows.set(user.id, messageWindow);
    }

    messageWindow.count += 1;

    if (messageWindow.count > 30) {
      return { ok: false, error: 'RATE_LIMITED' };
    }

    if (this.messageWindows.size > 10000) {
      for (const [userId, value] of this.messageWindows) {
        if (value.resetsAt <= now) {
          this.messageWindows.delete(userId);
        }
      }

      while (this.messageWindows.size > 10000) {
        const oldestUserId = this.messageWindows.keys().next().value;

        if (oldestUserId === undefined) {
          break;
        }

        this.messageWindows.delete(oldestUserId);
      }
    }

    let message: ClassroomMessage;

    try {
      message = await this.authService.createClassroomMessage(user.id, payload.courseId, body);
    } catch (error) {
      if (error instanceof ForbiddenException) {
        await socket.leave(room);
        return { ok: false, error: 'FORBIDDEN' };
      }

      throw error;
    }

    await this.emitToAuthorizedCourseSockets(room, payload.courseId, message);

    return { ok: true, message };
  }

  private async emitToAuthorizedCourseSockets(
    room: string,
    courseId: string,
    message: ClassroomMessage,
  ): Promise<void> {
    const sockets = await this.namespace.in(room).fetchSockets();
    const checked = await Promise.all(sockets.map(async (socket) => {
      const user = socket.data.user as { id?: string } | undefined;
      const sessionHash = socket.data.sessionHash as string | undefined;

      if (!user?.id || !sessionHash) {
        return { socket, authorized: false, disconnect: true };
      }

      if (!(await this.authService.isSessionActive(sessionHash, user.id))) {
        return { socket, authorized: false, disconnect: true };
      }

      const canReceive = await this.authService.canJoinCourse(user.id, courseId);
      return { socket, authorized: canReceive, disconnect: false };
    }));

    for (const recipient of checked) {
      if (recipient.disconnect) {
        recipient.socket.disconnect(true);
      } else if (!recipient.authorized) {
        recipient.socket.leave(room);
      } else {
        recipient.socket.emit('classroom:message:new', message);
      }
    }
  }

}
