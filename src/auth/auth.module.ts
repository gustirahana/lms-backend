import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionSocketRegistry } from './session-socket.registry';

@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionSocketRegistry],
  exports: [AuthService, SessionSocketRegistry],
})
export class AuthModule {}
