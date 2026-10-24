-- Encrypted canonical state and independently addressable encrypted transaction records.
-- The decrypted common transaction schema is src/lib/types.ts. Never send the encryption key to browsers.
create table public.expense_state(owner_id uuid primary key references auth.users(id),version bigint not null check(version>0),payload text not null);
create table public.transaction_records(owner_id uuid not null references auth.users(id),transaction_id uuid not null,fingerprint text not null,payload text not null,primary key(owner_id,transaction_id),unique(owner_id,fingerprint));
create table public.expense_history(owner_id uuid not null references auth.users(id),version bigint not null,payload text not null,created_at timestamptz not null default now(),primary key(owner_id,version));
create table public.expense_secrets(owner_id uuid not null references auth.users(id),name text not null,payload text not null,primary key(owner_id,name));
create table public.expense_locks(owner_id uuid not null references auth.users(id),name text not null,expires timestamptz not null,primary key(owner_id,name));
alter table public.expense_state enable row level security;
alter table public.transaction_records enable row level security;
alter table public.expense_history enable row level security;
alter table public.expense_secrets enable row level security;
alter table public.expense_locks enable row level security;
create policy owner_read on public.expense_state for select to authenticated using(auth.uid()=owner_id);
create policy owner_read on public.transaction_records for select to authenticated using(auth.uid()=owner_id);
create policy owner_read on public.expense_history for select to authenticated using(auth.uid()=owner_id);
create policy owner_secrets on public.expense_secrets for all to authenticated using(auth.uid()=owner_id) with check(auth.uid()=owner_id);
create policy owner_locks on public.expense_locks for all to authenticated using(auth.uid()=owner_id) with check(auth.uid()=owner_id);
-- State mutation only via optimistic, atomic RPC. No delete endpoint for imported source records.
create function public.save_expenses(expected_version bigint,new_payload text,records jsonb) returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare uid uuid:=auth.uid(); current_version bigint; r jsonb;
begin
 if uid is null then raise exception 'UNAUTHORIZED'; end if;
 perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
 select version into current_version from expense_state where owner_id=uid;
 if coalesce(current_version,0)<>expected_version then raise exception 'VERSION_CONFLICT'; end if;
 if length(new_payload)>50000000 or jsonb_array_length(records)>200000 then raise exception 'SIZE_LIMIT';end if;
 insert into expense_history(owner_id,version,payload) values(uid,expected_version+1,new_payload);
 insert into expense_state values(uid,expected_version+1,new_payload) on conflict(owner_id) do update set version=excluded.version,payload=excluded.payload;
 for r in select * from jsonb_array_elements(records) loop
  insert into transaction_records values(uid,(r->>'transaction_id')::uuid,r->>'fingerprint',r->>'payload') on conflict(owner_id,transaction_id) do update set payload=excluded.payload;
 end loop;
end $$;
revoke all on function public.save_expenses(bigint,text,jsonb) from public,anon;
grant execute on function public.save_expenses(bigint,text,jsonb) to authenticated;
create function public.lock_expenses(lock_name text) returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare changed integer;
begin
 insert into expense_locks values(auth.uid(),lock_name,now()+interval '30 minutes') on conflict(owner_id,name) do update set expires=excluded.expires where expense_locks.expires<now();
 get diagnostics changed=row_count; return changed=1;
end $$;
revoke all on function public.lock_expenses(text) from public,anon;
grant execute on function public.lock_expenses(text) to authenticated;
-- Scheduled job delegation is available only to the server-held service role.
create function public.save_expenses_job(job_owner uuid,expected_version bigint,new_payload text,records jsonb) returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform set_config('request.jwt.claim.sub',job_owner::text,true);
 perform public.save_expenses(expected_version,new_payload,records);
end $$;
revoke all on function public.save_expenses_job(uuid,bigint,text,jsonb) from public,anon,authenticated;
grant execute on function public.save_expenses_job(uuid,bigint,text,jsonb) to service_role;
create function public.lock_expenses_job(job_owner uuid,lock_name text) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform set_config('request.jwt.claim.sub',job_owner::text,true);
 return public.lock_expenses(lock_name);
end $$;
revoke all on function public.lock_expenses_job(uuid,text) from public,anon,authenticated;
grant execute on function public.lock_expenses_job(uuid,text) to service_role;
-- Explicit grants avoid relying on project-specific default privileges.
revoke all on public.expense_state,public.transaction_records,public.expense_history,public.expense_secrets,public.expense_locks from anon,authenticated;
grant select on public.expense_state,public.transaction_records,public.expense_history to authenticated;
grant select,insert,update,delete on public.expense_secrets,public.expense_locks to authenticated;
grant all on public.expense_state,public.transaction_records,public.expense_history,public.expense_secrets,public.expense_locks to service_role;
