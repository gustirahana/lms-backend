import { Injectable } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';

@Injectable()
export class CoursesService {
  constructor(private readonly authService: AuthService) {}

  findAll(query?: string) {
    return this.authService.findPublishedCourses(query);
  }
}
