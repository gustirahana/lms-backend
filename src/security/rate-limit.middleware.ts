import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

interface RateWindow { count: number; expiresAt: number }

@Injectable()
export class ApiRateLimitMiddleware implements NestMiddleware {
  private readonly clients = new Map<string, RateWindow>();
  private lastSweep = 0;

  constructor(
    private readonly maximum: number,
    private readonly windowMs: number,
    private readonly authMaximum: number,
    private readonly authWindowMs: number,
  ) {}

  private consume(key: string, maximum: number, duration: number, now: number): RateWindow | undefined {
    let bucket = this.clients.get(key);
    if (!bucket || bucket.expiresAt <= now) {
      // Do not evict active limits when the client table is full.
      if (!bucket && this.clients.size >= 10000) return undefined;
      bucket = { count: 0, expiresAt: now + duration };
      this.clients.set(key, bucket);
    }
    bucket.count = Math.min(bucket.count + 1, maximum + 1);
    return bucket;
  }

  use = (request: Request, response: Response, next: NextFunction): void => {
    const now = Date.now();
    if (now - this.lastSweep >= 10000) {
      for (const [key, bucket] of this.clients) {
        if (bucket.expiresAt <= now) this.clients.delete(key);
      }
      this.lastSweep = now;
    }
    const client = ipKeyGenerator(request.ip || request.socket.remoteAddress || 'unknown');
    const limits: Array<[string, number, number]> = [
      [`all:${client}`, this.maximum, this.windowMs],
      [`burst:${client}`, 30, 10000],
    ];
    // Match Express route casing and trailing-slash behavior.
    if (/^\/api\/auth\/login\/*$/i.test(request.path) && request.method === 'POST') {
      limits.push([`login:${client}`, this.authMaximum, this.authWindowMs]);
    }
    if (/^\/api\/health\/ready\/*$/i.test(request.path)) {
      limits.push([`ready:${client}`, 6, 60000]);
    }
    for (const [key, maximum, duration] of limits) {
      const bucket = this.consume(key, maximum, duration, now);
      const retry = bucket ? Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000)) : 10;
      response.setHeader('RateLimit-Limit', maximum);
      response.setHeader('RateLimit-Remaining', bucket ? Math.max(0, maximum - bucket.count) : 0);
      response.setHeader('RateLimit-Reset', retry);
      if (!bucket || bucket.count > maximum) {
        response.setHeader('Retry-After', retry);
        response.status(429).json({ statusCode: 429, message: 'Too many requests' });
        return;
      }
    }
    next();
  };
}
