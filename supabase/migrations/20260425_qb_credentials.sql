-- QuickBooks credential storage. Service role only.
-- Stores per-realm OAuth tokens that the Edge Functions read/write.

create table if not exists public.qb_credentials (
  realm_id    text primary key,
  environment text not null check (environment in ('sandbox','production')),
  refresh_token text not null,
  access_token  text,
  expires_at    timestamptz,
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- Lock down: enable RLS with no policies. Anon/authenticated roles cannot read or write.
-- Only the service role (used by Edge Functions) bypasses RLS.
alter table public.qb_credentials enable row level security;

-- Helpful index if we ever store multiple realms
create index if not exists qb_credentials_environment_idx on public.qb_credentials(environment);
