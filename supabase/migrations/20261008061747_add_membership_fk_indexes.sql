create index if not exists courses_owner_id_idx
  on public.courses (owner_id);

create index if not exists course_instructors_user_id_idx
  on public.course_instructors (user_id);

create index if not exists course_enrollments_course_id_idx
  on public.course_enrollments (course_id);

create index if not exists classroom_messages_sender_id_idx
  on public.classroom_messages (sender_id);
