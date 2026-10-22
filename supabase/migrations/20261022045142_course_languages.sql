alter table public.courses
  add column content_languages text[] not null default array['en']::text[],
  add column translations jsonb not null default '{}'::jsonb;

alter table public.courses
  add constraint courses_content_languages_valid check (
    array_ndims(content_languages) = 1
    and cardinality(content_languages) between 1 and 2
    and array_position(content_languages, null) is null
    and content_languages <@ array['id','en']::text[]
    and (cardinality(content_languages) = 1 or content_languages @> array['id','en']::text[])
  ),
  add constraint courses_translations_object check (jsonb_typeof(translations) = 'object');

comment on column public.courses.content_languages is 'Course content availability, independent of interface locale: id, en, or both.';
comment on column public.courses.translations is 'Localized title and description for supported course languages; not a curriculum or lesson store.';
