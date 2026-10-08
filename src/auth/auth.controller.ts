import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { loadConfig } from '../config';
import { AuthService, SessionRefreshInProgressException } from './auth.service';
import { SessionSocketRegistry } from './session-socket.registry';

export const SESSION_COOKIE = process.env.NODE_ENV === 'production' ? '__Host-lms_session' : 'lms_session';

export function readSessionCookie(request: Request): string | undefined {
  const name = SESSION_COOKIE;
  const cookies = request.headers.cookie?.split(';') || [];
  const item = cookies.map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(`${name}=`));

  if (!item) {
    return undefined;
  }

  try {
    return decodeURIComponent(item.slice(name.length + 1));
  } catch {
    return undefined;
  }
}

function assertAllowedOrigin(request: Request): void {
  const config = loadConfig(process.env);
  const origin = request.get('origin');

  if (!origin || !config.frontendOrigins.includes(origin)) {
    throw new ForbiddenException('Origin is not allowed');
  }
}

function cookieOptions(maxAge: number) {
  const config = loadConfig(process.env);

  return {
    httpOnly: true,
    secure: config.isProduction || process.env.COOKIE_SECURE === 'true',
    sameSite: config.cookieSameSite,
    path: '/',
    maxAge,
  } as const;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly sessionSocketRegistry: SessionSocketRegistry,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    assertAllowedOrigin(request);
    const body = request.body as Record<string, unknown>;

    if (
      !body ||
      Object.keys(body).some((key) => !['email', 'password'].includes(key)) ||
      typeof body.email !== 'string' ||
      body.email.length > 320 ||
      !/^\S+@\S+\.\S+$/.test(body.email) ||
      typeof body.password !== 'string' ||
      body.password.length < 1 ||
      body.password.length > 1024
    ) {
      throw new BadRequestException('A valid email and password are required');
    }

    const session = await this.authService.login(body.email, body.password);
    response.cookie(SESSION_COOKIE, session.cookie, cookieOptions(session.cookieMaxAgeMs));

    return { user: session.user };
  }

  @Get('session')
  async getSession(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const cookie = readSessionCookie(request);

    if (!cookie) {
      throw new UnauthorizedException('Not authenticated');
    }

    const user = await this.authService.getAuthenticatedUser(cookie);

    if (!user) {
      response.clearCookie(SESSION_COOKIE, cookieOptions(0));
      throw new UnauthorizedException('Session expired');
    }

    return { user };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    assertAllowedOrigin(request);
    const cookie = readSessionCookie(request);

    if (!cookie) {
      throw new UnauthorizedException('Not authenticated');
    }

    let refreshed: Awaited<ReturnType<AuthService['refresh']>>;

    try {
      refreshed = await this.authService.refresh(cookie);
    } catch (error) {
      if (error instanceof SessionRefreshInProgressException) {
        response.setHeader('Retry-After', '1');
      } else if (error instanceof UnauthorizedException) {
        response.clearCookie(SESSION_COOKIE, cookieOptions(0));
      }

      throw error;
    }

    response.cookie(SESSION_COOKIE, cookie, cookieOptions(refreshed.cookieMaxAgeMs));

    return { user: refreshed.user };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<void> {
    assertAllowedOrigin(request);
    const cookie = readSessionCookie(request);

    if (cookie) {
      const sessionHash = await this.authService.logout(cookie);

      if (sessionHash) {
        this.sessionSocketRegistry.disconnectSession(sessionHash);
      }
    }

    response.clearCookie(SESSION_COOKIE, cookieOptions(0));
  }
}
