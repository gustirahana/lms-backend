import { NextFunction, Request, Response } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function originCheck(allowedOrigins: string[]) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(request.method)) {
      next();
      return;
    }

    const origin = request.get('origin');

    if (!origin || !allowedOrigins.includes(origin)) {
      response.status(403).json({ statusCode: 403, message: 'Origin is not allowed' });
      return;
    }

    next();
  };
}
