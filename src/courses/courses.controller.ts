import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { CoursesService } from './courses.service';

@Controller('courses')
export class CoursesController {
  constructor(private readonly coursesService: CoursesService) {}

  @Get()
  findAll(@Query('q') query?: string) {
    if (query !== undefined && (query.length > 100 || query.trim().length === 0)) {
      throw new BadRequestException('q must contain between 1 and 100 non-whitespace characters');
    }

    return this.coursesService.findAll(query);
  }
}
