import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { AuthService } from './auth/auth.service';

@Controller('health')
export class HealthController {
  constructor(private readonly authService: AuthService) {}

  @Get()
  getHealth(): { status: string; service: string } {
    return { status: 'ok', service: 'learning-platform-api' };
  }

  @Get('ready')
  async getReadiness(@Res({ passthrough: true }) response: Response) {
    try {
      const ready = await this.authService.checkDatabaseReadiness();

      if (!ready) {
        response.status(503);
        return { status: 'not_ready', checks: { supabase: 'schema_missing' } };
      }

      return { status: 'ready', checks: { application: 'ok', supabase: 'ok' } };
    } catch {
      response.status(503);
      return { status: 'not_ready', checks: { supabase: 'unavailable' } };
    }
  }
}
