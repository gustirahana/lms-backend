create index if not exists app_sessions_revoked_at_idx
  on public.app_sessions (revoked_at)
  where revoked_at is not null;
