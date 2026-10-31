-- Utenti che possono usare SOLO i programmi DDT (non vedono fatture, banche, buste paga...).
-- Per aggiungere qualcuno: crea l'utente in Supabase (Authentication > Users > Invite) e poi
--   insert into utenti_ddt (user_id, email) select id, email from auth.users where email = 'nome@esempio.it';

create table if not exists public.utenti_ddt (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  creato_il timestamptz not null default now()
);
alter table public.utenti_ddt enable row level security;
drop policy if exists solo_utenti_autorizzati on public.utenti_ddt;
create policy solo_utenti_autorizzati on public.utenti_ddt for all to authenticated
  using ((select public.is_autorizzato())) with check ((select public.is_autorizzato()));
comment on table public.utenti_ddt is 'Utenti con accesso solo ai programmi DDT ricevuti / DDT da fatture. Gli utenti_autorizzati hanno gia'' accesso a tutto.';

create or replace function public.is_utente_ddt() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.utenti_autorizzati where user_id = (select auth.uid()))
      or exists (select 1 from public.utenti_ddt where user_id = (select auth.uid()))
$$;
revoke execute on function public.is_utente_ddt() from anon, public;
grant execute on function public.is_utente_ddt() to authenticated;

-- le tabelle DDT: autorizzati + utenti DDT
drop policy if exists solo_utenti_autorizzati on public.ddt_ricevuti;
drop policy if exists utenti_ddt on public.ddt_ricevuti;
create policy utenti_ddt on public.ddt_ricevuti for all to authenticated
  using ((select public.is_utente_ddt())) with check ((select public.is_utente_ddt()));

drop policy if exists solo_utenti_autorizzati on public.contatori_protocollo_ddt;
drop policy if exists utenti_ddt on public.contatori_protocollo_ddt;
create policy utenti_ddt on public.contatori_protocollo_ddt for all to authenticated
  using ((select public.is_utente_ddt())) with check ((select public.is_utente_ddt()));

drop policy if exists solo_utenti_autorizzati on public.ddt_riferimenti_fatture;
drop policy if exists utenti_ddt on public.ddt_riferimenti_fatture;
create policy utenti_ddt on public.ddt_riferimenti_fatture for all to authenticated
  using ((select public.is_utente_ddt())) with check ((select public.is_utente_ddt()));

-- archivio file: gli utenti DDT vedono solo la cartella ddt-ricevuti
drop policy if exists utenti_ddt_file on storage.objects;
create policy utenti_ddt_file on storage.objects for all to authenticated
  using (bucket_id = 'ddt-ricevuti' and (select public.is_utente_ddt()))
  with check (bucket_id = 'ddt-ricevuti' and (select public.is_utente_ddt()));
