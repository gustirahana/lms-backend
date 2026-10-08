import { Injectable } from '@nestjs/common';
import { Socket } from 'socket.io';

@Injectable()
export class SessionSocketRegistry {
  private readonly socketsBySession = new Map<string, Set<Socket>>();

  add(sessionHash: string, socket: Socket): void {
    let sockets = this.socketsBySession.get(sessionHash);

    if (!sockets) {
      sockets = new Set();
      this.socketsBySession.set(sessionHash, sockets);
    }

    sockets.add(socket);
  }

  remove(sessionHash: string, socket: Socket): void {
    const sockets = this.socketsBySession.get(sessionHash);

    if (!sockets) {
      return;
    }

    sockets.delete(socket);

    if (sockets.size === 0) {
      this.socketsBySession.delete(sessionHash);
    }
  }

  disconnectSession(sessionHash: string): void {
    const sockets = this.socketsBySession.get(sessionHash);

    if (!sockets) {
      return;
    }

    for (const socket of sockets) {
      socket.disconnect(true);
    }

    this.socketsBySession.delete(sessionHash);
  }
}
