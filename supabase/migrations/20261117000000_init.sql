-- 여자풋살 팀 찾기 스키마. 서버만 secret 키로 접근하므로 RLS를 켜고 정책은 두지 않는다(anon 키로는 아무것도 못 읽음).
create table teams (
  id bigint generated always as identity primary key,
  name text not null,
  region text not null,
  district text,
  level text check (level in ('beginner', 'intermediate', 'advanced')),
  instagram text,
  contact text,
  orientation text check (orientation in ('competition', 'friendly', 'both')),
  has_coach boolean,
  coach_info text,
  members int,
  recruiting boolean,
  note text,
  source_url text,
  updated_at timestamptz not null default now()
);

create table requests (
  id bigint generated always as identity primary key,
  type text not null check (type in ('add', 'edit')),
  team_id bigint references teams (id) on delete set null,
  payload jsonb not null,
  requester text,
  message text,
  ip_hash text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);

create index requests_status_idx on requests (status);
create index requests_ip_idx on requests (ip_hash, created_at);

alter table teams enable row level security;
alter table requests enable row level security;
