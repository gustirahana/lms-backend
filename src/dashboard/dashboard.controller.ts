import { Controller, Get, Req, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { readSessionCookie } from '../auth/auth.controller';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly authService: AuthService) {}

  @Get()
  async getDashboard(@Req() request: Request) {
    const cookie = readSessionCookie(request);
    const user = cookie ? await this.authService.getAuthenticatedUser(cookie) : undefined;

    if (!user) {
      throw new UnauthorizedException('Not authenticated');
    }

    return this.authService.getDashboard(user.id);
  }
}
