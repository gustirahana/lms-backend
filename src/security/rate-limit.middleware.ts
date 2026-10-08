import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

interface RateWindow {
  count: number;
  expiresAt: number;
}

@Injectable()
export class ApiRateLimitMiddleware implements NestMiddleware {
  private readonly clients = new Map<string, RateWindow>();

  constructor(
    private readonly maximum: number,
    private readonly windowMs: number,
    private readonly authMaximum: number,
    private readonly authWindowMs: number,
  ) {}

  use = (request: Request, response: Response, next: NextFunction): void => {
    if (request.path === '/api/health' || request.path === '/api/health/ready') {
      next();
      return;
    }

    const now = Date.now();
    const client = request.ip || request.socket.remoteAddress || 'unknown';
    const isLogin = request.path === '/api/auth/login' && request.method === 'POST';
    const key = isLogin ? `auth:${client}` : client;
    const maximum = isLogin ? this.authMaximum : this.maximum;
    const windowMs = isLogin ? this.authWindowMs : this.windowMs;
    let window = this.clients.get(key);

    if (!window || window.expiresAt <= now) {
      window = { count: 0, expiresAt: now + windowMs };
      this.clients.set(key, window);
    }

    window.count += 1;
    response.setHeader('RateLimit-Limit', maximum);
    response.setHeader('RateLimit-Remaining', Math.max(0, maximum - window.count));

    if (window.count > maximum) {
      response.setHeader('Retry-After', Math.max(1, Math.ceil((window.expiresAt - now) / 1000)));
      response.status(429).json({ statusCode: 429, message: 'Too many requests' });
      return;
    }

    if (this.clients.size > 10000) {
      for (const [key, value] of this.clients) {
        if (value.expiresAt <= now) {
          this.clients.delete(key);
        }
      }

      while (this.clients.size > 10000) {
        const oldestClient = this.clients.keys().next().value;

        if (oldestClient === undefined) {
          break;
        }

        this.clients.delete(oldestClient);
      }
    }

    next();
  };
}
