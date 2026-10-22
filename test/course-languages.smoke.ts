import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AuthService } from '../src/auth/auth.service';
import { CoursesController } from '../src/courses/courses.controller';
import { CoursesService } from '../src/courses/courses.service';

async function main() {
  process.env.NODE_ENV = 'test';
  process.env.SUPABASE_URL = 'https://supabase.example.test';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_synthetic';
  const source = JSON.parse(readFileSync('demo/courses.json', 'utf8'));
  const rows = source.map((course: { languages: string[]; durationMinutes: number; lessons: number }) => ({
    ...course, content_languages: course.languages, duration_minutes: course.durationMinutes,
    lesson_count: course.lessons,
  }));
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify(rows), { status: 200 });
  try {
    const auth = new AuthService();
    assert.equal((await auth.findPublishedCourses()).length, 9);
    for (const language of ['id', 'en', 'both'] as const) {
      const courses = await auth.findPublishedCourses(undefined, language);
      assert.equal(courses.length, 3);
      assert.ok(courses.every(course => language === 'both' ? course.languages.length === 2 : course.languages.length === 1 && course.languages[0] === language));
    }
    const bilingual = await auth.findPublishedCourses(undefined, 'both');
    assert.ok(bilingual.every(course => course.translations.id?.title && course.translations.en?.title));
    const controller = new CoursesController(new CoursesService(auth));
    assert.throws(() => controller.findAll(undefined, 'fr'), /language must be/);
    assert.equal((await controller.findAll(undefined, 'id')).length, 3);
    console.log('Verified course language metadata, translations, exclusive filtering, and invalid-language rejection.');
  } finally { global.fetch = originalFetch; }
}
void main();
