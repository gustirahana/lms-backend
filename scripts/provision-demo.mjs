import 'dotenv/config';
import { randomBytes } from 'node:crypto';

const apiUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!apiUrl || !secret) throw new Error('Set server-side SUPABASE_URL and SUPABASE_SECRET_KEY first.');
const demoPassword = 'JakIja-Learn-Demo-2026!';
const learnerId = '7b810000-0000-4000-8000-000000000001';
const teacherId = '7b810000-0000-4000-8000-000000000002';

async function request(path, { method = 'GET', body, prefer } = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    method, signal: AbortSignal.timeout(20000),
    headers: { apikey: secret, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]} failed (${response.status}); no credentials logged.`);
  return response.status === 204 ? null : response.json().catch(() => null);
}

async function ensureDemoUser(id, email, displayName, password) {
  const response = await fetch(`${apiUrl}/auth/v1/admin/users/${id}`, {
    headers: { apikey: secret }, signal: AbortSignal.timeout(20000),
  });
  if (response.status === 404) {
    const created = await request('/auth/v1/admin/users', { method: 'POST', body: {
      id, email, password, email_confirm: true,
      user_metadata: { display_name: displayName }, app_metadata: { showcase_demo: true },
    } });
    if (created.id !== id) throw new Error('Auth did not preserve the expected demo ID; stop and inspect provisioning.');
    return;
  }
  if (!response.ok) throw new Error(`Could not inspect demo user (${response.status}).`);
  const user = await response.json();
  if (user.email !== email || user.app_metadata?.showcase_demo !== true) {
    throw new Error('The fixed demo ID belongs to a different account; no update attempted.');
  }
  // Only the explicitly marked shared learner has a public password.
  if (id === learnerId) await request(`/auth/v1/admin/users/${id}`, { method: 'PUT', body: { password } });
}

await ensureDemoUser(teacherId, 'teacher.demo@jakija.example', 'JakIja Demo Studio', randomBytes(36).toString('base64url'));
await ensureDemoUser(learnerId, 'learner.demo@jakija.example', 'Demo Learner', demoPassword);
const upsert = (table, body, conflict) => request(`/rest/v1/${table}?on_conflict=${conflict}`, {
  method: 'POST', body, prefer: 'resolution=merge-duplicates,return=minimal',
});
await upsert('profiles', [
  { id: teacherId, display_name: 'JakIja Demo Studio', role: 'instructor' },
  { id: learnerId, display_name: 'Demo Learner', role: 'learner' },
], 'id');
const courses = [
  { id: '7b810001-0000-4000-8000-000000000001', title: 'Interfaces that make sense', category: 'Design', duration_minutes: 180, lesson_count: 12, accent: 'lavender', icon: 'Aa', level: 'beginner', description: 'A sample learning path through hierarchy, typography, and accessible interface patterns.' },
  { id: '7b810001-0000-4000-8000-000000000002', title: 'Build your first React workspace', category: 'Development', duration_minutes: 300, lesson_count: 18, accent: 'peach', icon: '</>', level: 'intermediate', description: 'A sample course on components, application state, and connecting a learner interface to an API.' },
  { id: '7b810001-0000-4000-8000-000000000003', title: 'A thoughtful start with APIs', category: 'Backend', duration_minutes: 120, lesson_count: 8, accent: 'mint', icon: '{ }', level: 'beginner', description: 'A sample course exploring API contracts, cookie sessions, and access boundaries with NestJS.' },
];
// Inspect fixed IDs before upserting so an unrelated course is never overwritten.
const existing = await request(`/rest/v1/courses?id=in.(${courses.map(c => c.id).join(',')})&select=id,owner_id`);
if (existing.some(course => course.owner_id !== teacherId)) throw new Error('A demo course ID belongs to another owner; refusing to overwrite it.');
await upsert('courses', courses.map(course => ({ ...course, owner_id: teacherId, status: 'published' })), 'id');
await upsert('course_enrollments', courses.map(course => ({ user_id: learnerId, course_id: course.id, status: 'active' })), 'user_id,course_id');
await upsert('course_progress', courses.map((course, index) => ({ user_id: learnerId, course_id: course.id, progress_percent: [42, 18, 0][index], minutes_spent: [75, 54, 0][index] })), 'user_id,course_id');
await upsert('classroom_messages', [{ id: '7b810002-0000-4000-8000-000000000001', course_id: courses[0].id, sender_id: teacherId, body: 'Welcome to the shared demo classroom. This is fictional sample content. Try sending a short fictional message to explore the realtime conversation.' }], 'id');
const profile = await request(`/rest/v1/profiles?id=eq.${learnerId}&select=role`);
const enrollments = await request(`/rest/v1/course_enrollments?user_id=eq.${learnerId}&select=course_id`);
if (profile[0]?.role !== 'learner' || enrollments.length !== 3) throw new Error('Demo provisioning verification failed.');
console.log('Verified shared learner account, private instructor, 3 sample courses/enrollments, progress, and sample classroom message.');
