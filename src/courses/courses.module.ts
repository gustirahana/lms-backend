import { Module } from '@nestjs/common';
import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  controllers: [CoursesController],
  providers: [CoursesService],
  imports: [AuthModule],
})
export class CoursesModule {}
