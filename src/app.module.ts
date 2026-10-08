import { Module } from '@nestjs/common';
import { CoursesModule } from './courses/courses.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { HealthController } from './health.controller';
import { AuthModule } from './auth/auth.module';
import { RealtimeModule } from './realtime/realtime.module';

@Module({
  imports: [AuthModule, CoursesModule, DashboardModule, RealtimeModule],
  controllers: [HealthController],
})
export class AppModule {}
