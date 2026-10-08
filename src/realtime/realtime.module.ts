import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClassroomGateway } from './classroom.gateway';
import { NotificationsGateway } from './notifications.gateway';

@Module({
  imports: [AuthModule],
  providers: [ClassroomGateway, NotificationsGateway],
  exports: [ClassroomGateway, NotificationsGateway],
})
export class RealtimeModule {}
