-- Riferimenti DDT del blocco <DatiDDT> delle fatture d'acquisto (salvati da importa-xml-fatture).
-- (eseguito a mano dall'SQL editor il 01/11/2026)
create table if not exists public.fatture_dati_ddt (
  id uuid primary key default gen_random_uuid(),
  fattura_id uuid not null references public.fatture(id) on delete cascade,
  numero_ddt text not null,
  data_ddt date,
  linee text,
  creato_il timestamptz not null default now()
);
create unique index if not exists fatture_dati_ddt_uk on public.fatture_dati_ddt (fattura_id, numero_ddt, coalesce(data_ddt, '1900-01-01'));
alter table public.fatture_dati_ddt enable row level security;
drop policy if exists solo_utenti_autorizzati on public.fatture_dati_ddt;
create policy solo_utenti_autorizzati on public.fatture_dati_ddt for all to authenticated
  using ((select public.is_autorizzato())) with check ((select public.is_autorizzato()));
