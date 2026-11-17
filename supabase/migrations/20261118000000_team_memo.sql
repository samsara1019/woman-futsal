-- 팀 카드의 '자세히 보기'에 공개되는 메모 (회비, 준비물, 가입 조건 등)
alter table teams add column if not exists memo text;
