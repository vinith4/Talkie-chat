-- Chatter initial schema: tables, indexes, RLS, functions, realtime
create extension if not exists pgcrypto;

create type conversation_type as enum ('DIRECT','GROUP');
create type member_role as enum ('OWNER','ADMIN','MEMBER');
create type call_type as enum ('VOICE','VIDEO');
create type call_status as enum ('RINGING','ACCEPTED','REJECTED','MISSED','ENDED');

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null check (username ~ '^[a-z0-9_]{3,24}$'),
  display_name text not null,
  email text,
  avatar_url text,
  bio text default '',
  status text default '',
  is_online boolean not null default false,
  last_seen timestamptz,
  privacy jsonb not null default '{"last_seen":true,"online":true,"read_receipts":true,"who_can_call":"everyone"}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  type conversation_type not null,
  name text, description text,
  direct_key text unique, -- 'minuuid:maxuuid' prevents duplicate DMs
  created_by uuid references profiles(id),
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (type = 'GROUP' or direct_key is not null)
);

create table conversation_members (
  conversation_id uuid references conversations(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  role member_role not null default 'MEMBER',
  last_read_at timestamptz not null default 'epoch',
  is_archived boolean not null default false,
  is_favorite boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index on conversation_members(user_id);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_id uuid not null references profiles(id),
  content text not null check (char_length(content) <= 4000),
  message_type text not null default 'TEXT',
  reply_to_message_id uuid references messages(id) on delete set null,
  is_edited boolean not null default false,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index messages_conv_created on messages(conversation_id, created_at desc);
create index messages_fts on messages using gin (to_tsvector('simple', content)) where not is_deleted;

create table message_reactions (
  message_id uuid references messages(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  emoji text not null check (char_length(emoji) <= 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create table pinned_messages (
  conversation_id uuid references conversations(id) on delete cascade,
  message_id uuid references messages(id) on delete cascade,
  pinned_by uuid references profiles(id),
  pinned_at timestamptz not null default now(),
  primary key (conversation_id, message_id)
);

create table blocked_users (
  blocker_id uuid references profiles(id) on delete cascade,
  blocked_id uuid references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id), check (blocker_id <> blocked_id)
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  type text not null, payload jsonb not null default '{}',
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);
create index on notifications(user_id, created_at desc);

create table call_history (
  id uuid primary key default gen_random_uuid(),
  caller_id uuid not null references profiles(id),
  receiver_id uuid not null references profiles(id),
  conversation_id uuid references conversations(id) on delete set null,
  call_type call_type not null,
  status call_status not null default 'RINGING',
  started_at timestamptz, ended_at timestamptz, duration integer,
  created_at timestamptz not null default now()
);
create index on call_history(caller_id, created_at desc);
create index on call_history(receiver_id, created_at desc);

-- Helpers (security definer avoids recursive RLS)
create function is_member(cid uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists(select 1 from conversation_members where conversation_id = cid and user_id = auth.uid()) $$;

create function is_admin(cid uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists(select 1 from conversation_members where conversation_id = cid and user_id = auth.uid() and role in ('OWNER','ADMIN')) $$;

create function can_send(cid uuid) returns boolean language sql stable security definer set search_path = public as
$$ select is_member(cid) and not exists(
  select 1 from conversations c join conversation_members m on m.conversation_id = c.id and m.user_id <> auth.uid()
  join blocked_users b on (b.blocker_id = m.user_id and b.blocked_id = auth.uid()) or (b.blocker_id = auth.uid() and b.blocked_id = m.user_id)
  where c.id = cid and c.type = 'DIRECT') $$;

-- RPCs for operations that need privileged multi-row writes
create function start_direct_conversation(other uuid) returns uuid language plpgsql security definer set search_path = public as $$
declare k text; cid uuid;
begin
  if other = auth.uid() then raise exception 'Cannot chat with yourself'; end if;
  if exists(select 1 from blocked_users where (blocker_id=other and blocked_id=auth.uid()) or (blocker_id=auth.uid() and blocked_id=other)) then
    raise exception 'User blocked'; end if;
  k := least(auth.uid()::text, other::text) || ':' || greatest(auth.uid()::text, other::text);
  select id into cid from conversations where direct_key = k;
  if cid is null then
    insert into conversations(type, direct_key, created_by) values ('DIRECT', k, auth.uid()) returning id into cid;
    insert into conversation_members(conversation_id, user_id) values (cid, auth.uid()), (cid, other);
  end if;
  return cid;
end $$;

create function create_group(p_name text, p_members uuid[]) returns uuid language plpgsql security definer set search_path = public as $$
declare cid uuid; u uuid;
begin
  insert into conversations(type, name, created_by) values ('GROUP', p_name, auth.uid()) returning id into cid;
  insert into conversation_members(conversation_id, user_id, role) values (cid, auth.uid(), 'OWNER');
  foreach u in array p_members loop
    if u <> auth.uid() then insert into conversation_members(conversation_id, user_id) values (cid, u) on conflict do nothing; end if;
  end loop;
  return cid;
end $$;

create function set_member_role(cid uuid, uid uuid, new_role member_role) returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin(cid) then raise exception 'Forbidden'; end if;
  if new_role = 'OWNER' or exists(select 1 from conversation_members where conversation_id=cid and user_id=uid and role='OWNER') then
    raise exception 'Cannot change owner role'; end if;
  update conversation_members set role = new_role where conversation_id = cid and user_id = uid;
end $$;

-- Triggers
create function handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles(id, email, username, display_name)
  values (new.id, new.email,
    lower(regexp_replace(split_part(new.email,'@',1),'[^a-z0-9_]','','gi')) || substr(replace(new.id::text,'-',''),1,4),
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1)));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

create function on_message_insert() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update conversations set last_message_at = new.created_at where id = new.conversation_id;
  insert into notifications(user_id, type, payload)
  select user_id, 'message', jsonb_build_object('conversation_id', new.conversation_id, 'sender_id', new.sender_id)
  from conversation_members where conversation_id = new.conversation_id and user_id <> new.sender_id;
  return new;
end $$;
create trigger trg_message_insert after insert on messages for each row execute function on_message_insert();

create function on_message_update() returns trigger language plpgsql as $$
begin
  if new.content is distinct from old.content then new.is_edited := true; end if;
  new.updated_at := now(); return new;
end $$;
create trigger trg_message_update before update on messages for each row execute function on_message_update();

-- Column-level privileges: block privilege escalation via direct updates
revoke update on profiles, conversation_members, messages, conversations from authenticated;
grant update (username, display_name, avatar_url, bio, status, privacy, is_online, last_seen) on profiles to authenticated;
grant update (last_read_at, is_archived, is_favorite) on conversation_members to authenticated;
grant update (content, is_deleted) on messages to authenticated;
grant update (name, description) on conversations to authenticated;

-- RLS
alter table profiles enable row level security;
alter table conversations enable row level security;
alter table conversation_members enable row level security;
alter table messages enable row level security;
alter table message_reactions enable row level security;
alter table pinned_messages enable row level security;
alter table blocked_users enable row level security;
alter table notifications enable row level security;
alter table call_history enable row level security;

create policy profiles_read on profiles for select to authenticated using (true);
create policy profiles_update on profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy conv_read on conversations for select to authenticated using (is_member(id));
create policy conv_update on conversations for update to authenticated using (type='GROUP' and is_admin(id));

create policy mem_read on conversation_members for select to authenticated using (is_member(conversation_id));
create policy mem_self_update on conversation_members for update to authenticated using (user_id = auth.uid());
create policy mem_add on conversation_members for insert to authenticated
  with check (is_admin(conversation_id) and exists(select 1 from conversations where id = conversation_id and type='GROUP'));
create policy mem_remove on conversation_members for delete to authenticated
  using ((user_id = auth.uid() and role <> 'OWNER') or (is_admin(conversation_id) and role <> 'OWNER'));

create policy msg_read on messages for select to authenticated using (is_member(conversation_id));
create policy msg_insert on messages for insert to authenticated with check (sender_id = auth.uid() and can_send(conversation_id));
create policy msg_update on messages for update to authenticated using (sender_id = auth.uid()) with check (sender_id = auth.uid());

create policy react_read on message_reactions for select to authenticated
  using (exists(select 1 from messages m where m.id = message_id and is_member(m.conversation_id)));
create policy react_add on message_reactions for insert to authenticated
  with check (user_id = auth.uid() and exists(select 1 from messages m where m.id = message_id and is_member(m.conversation_id)));
create policy react_del on message_reactions for delete to authenticated using (user_id = auth.uid());

create policy pin_read on pinned_messages for select to authenticated using (is_member(conversation_id));
create policy pin_add on pinned_messages for insert to authenticated with check (pinned_by = auth.uid() and is_member(conversation_id));
create policy pin_del on pinned_messages for delete to authenticated using (is_member(conversation_id));

create policy block_all on blocked_users for all to authenticated using (blocker_id = auth.uid()) with check (blocker_id = auth.uid());

create policy notif_read on notifications for select to authenticated using (user_id = auth.uid());
create policy notif_update on notifications for update to authenticated using (user_id = auth.uid());

create policy call_read on call_history for select to authenticated using (auth.uid() in (caller_id, receiver_id));
create policy call_insert on call_history for insert to authenticated with check (caller_id = auth.uid());
create policy call_update on call_history for update to authenticated using (auth.uid() in (caller_id, receiver_id));

-- Realtime (ephemeral typing/presence/signaling use Broadcast/Presence, not tables)
alter publication supabase_realtime add table messages, message_reactions, pinned_messages, conversation_members, notifications, call_history;
