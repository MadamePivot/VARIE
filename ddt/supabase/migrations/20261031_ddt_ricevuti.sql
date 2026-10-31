-- DDT RICEVUTI DAI FORNITORI (Madame Pivot e MP Spazio Lab)
-- Flusso: file caricato o arrivato via email -> lettura AI -> conferma -> protocollo AZ-ANNO-NNNN -> archivio.
-- Le tabelle ddt / righe_ddt gia' esistenti sono per i DDT EMESSI e non vengono toccate.

-- ---------------------------------------------------------------- DDT ricevuti
create table if not exists public.ddt_ricevuti (
  id uuid primary key default gen_random_uuid(),
  stato text not null default 'in_lettura'
    check (stato in ('in_lettura','da_confermare','protocollato','scartato')),
  azienda text check (azienda in ('MADAME PIVOT SRL','MP SPAZIO LAB SRL')),

  -- protocollo: assegnato solo alla conferma, numerazione per azienda e anno
  anno_protocollo int,
  numero_protocollo int,
  protocollo text generated always as (
    case when numero_protocollo is null then null
         else (case azienda when 'MADAME PIVOT SRL' then 'MP' else 'LAB' end)
              || '-' || anno_protocollo || '-' || lpad(numero_protocollo::text, 4, '0') end
  ) stored,
  protocollato_il timestamptz,

  -- dati letti dal documento
  fornitore_denominazione text,
  fornitore_piva text,
  numero_ddt text,
  numero_chiave text,          -- numero normalizzato per l'abbinamento con le fatture ("00669" -> "669")
  data_ddt date,
  causale_trasporto text,
  destinazione text,
  vettore text,
  numero_colli text,
  peso text,
  aspetto_beni text,
  riferimento_ordine text,
  righe jsonb not null default '[]'::jsonb,   -- [{codice, descrizione, quantita, unita_misura}]
  note text,
  avviso_lettura text,         -- dubbi segnalati dalla lettura AI (es. "il file contiene 2 DDT")
  dati_letti jsonb,            -- risposta completa della lettura, per controllo

  -- file e provenienza
  file_path text not null,
  file_nome text,
  file_tipo text,
  impronta text,               -- sha256 del file: evita di caricare due volte lo stesso documento
  origine text not null default 'caricamento' check (origine in ('caricamento','email')),
  email_message_id text,
  email_mittente text,
  email_oggetto text,

  creato_da uuid default auth.uid(),
  creato_il timestamptz not null default now(),
  aggiornato_il timestamptz not null default now(),

  constraint ddt_ricevuti_protocollo_uk unique (azienda, anno_protocollo, numero_protocollo)
);
create unique index if not exists ddt_ricevuti_impronta_uk on public.ddt_ricevuti (impronta) where impronta is not null and stato <> 'scartato';
create index if not exists ddt_ricevuti_stato_idx on public.ddt_ricevuti (stato);
create index if not exists ddt_ricevuti_abbina_idx on public.ddt_ricevuti (azienda, numero_chiave);
comment on table public.ddt_ricevuti is 'DDT ricevuti dai fornitori (caricati dalla pagina DDT o arrivati a madamepivotdocuments@gmail.com con oggetto DDT), letti con AI e protocollati per azienda e anno (MP-2026-0001, LAB-2026-0001).';

-- contatore protocollo per azienda e anno
create table if not exists public.contatori_protocollo_ddt (
  azienda text not null,
  anno int not null,
  ultimo_numero int not null default 0,
  primary key (azienda, anno)
);
comment on table public.contatori_protocollo_ddt is 'Ultimo numero di protocollo DDT ricevuti per azienda e anno. Lo aggiorna solo la funzione protocolla_ddt.';

-- ---------------------------------------------------------------- riferimenti DDT nelle fatture d'acquisto
create table if not exists public.ddt_riferimenti_fatture (
  id uuid primary key default gen_random_uuid(),
  chiave text not null unique,          -- fattura_id|numero_chiave|data: evita doppioni a ogni aggiornamento
  azienda text not null,
  fattura_id uuid not null references public.fatture(id) on delete cascade,
  fattura_numero text,
  fattura_data date,
  fornitore_denominazione text,
  fornitore_piva text,
  numero_ddt text not null,
  numero_chiave text not null,
  data_ddt date,
  ddt_nostro boolean not null default false,  -- "Rif. VS DDT": e' un nostro DDT (conto lavoro), non uno da ricevere
  testo text,
  ddt_ricevuto_id uuid references public.ddt_ricevuti(id) on delete set null,
  smarcato_manuale boolean not null default false,
  nota text,
  creato_il timestamptz not null default now()
);
create index if not exists ddt_rif_abbina_idx on public.ddt_riferimenti_fatture (azienda, numero_chiave) where ddt_ricevuto_id is null;
comment on table public.ddt_riferimenti_fatture is 'Numeri DDT citati nelle righe delle fatture d''acquisto (dal 2026). Si smarcano quando il DDT viene caricato e protocollato (abbina_ddt) o a mano.';

-- ---------------------------------------------------------------- funzioni
create or replace function public.ddt_piva_norm(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(regexp_replace(regexp_replace(upper(coalesce(p,'')), '[^A-Z0-9]', '', 'g'), '^IT', ''), '')
$$;

-- collega i riferimenti delle fatture ai DDT protocollati (stessa azienda, stesso fornitore, stesso numero, data compatibile)
create or replace function public.abbina_ddt() returns int
language plpgsql set search_path = public as $$
declare n int;
begin
  update ddt_riferimenti_fatture r set ddt_ricevuto_id = d.id
  from ddt_ricevuti d
  where r.ddt_ricevuto_id is null
    and d.stato = 'protocollato'
    and d.azienda = r.azienda
    and d.numero_chiave = r.numero_chiave
    and (r.data_ddt is null or d.data_ddt is null or d.data_ddt = r.data_ddt)
    and (
      ddt_piva_norm(d.fornitore_piva) = ddt_piva_norm(r.fornitore_piva)
      or (ddt_piva_norm(d.fornitore_piva) is null and lower(d.fornitore_denominazione) = lower(r.fornitore_denominazione))
    );
  get diagnostics n = row_count;
  return n;
end $$;

-- assegna il protocollo a un DDT confermato (numero progressivo per azienda e anno, senza buchi)
create or replace function public.protocolla_ddt(p_id uuid) returns text
language plpgsql set search_path = public as $$
declare d ddt_ricevuti; a int := extract(year from now() at time zone 'Europe/Rome')::int; n int; prot text;
begin
  select * into d from ddt_ricevuti where id = p_id for update;
  if not found then raise exception 'DDT non trovato'; end if;
  if d.stato = 'protocollato' then return d.protocollo; end if;
  if d.azienda is null then raise exception 'Scegli l''azienda prima di protocollare'; end if;
  insert into contatori_protocollo_ddt (azienda, anno, ultimo_numero) values (d.azienda, a, 1)
  on conflict (azienda, anno) do update set ultimo_numero = contatori_protocollo_ddt.ultimo_numero + 1
  returning ultimo_numero into n;
  update ddt_ricevuti set stato = 'protocollato', anno_protocollo = a, numero_protocollo = n,
         protocollato_il = now(), aggiornato_il = now()
   where id = p_id returning protocollo into prot;
  perform abbina_ddt();
  return prot;
end $$;

-- numero normalizzato e data di aggiornamento sempre coerenti
create or replace function public.ddt_ricevuti_prima_di_salvare() returns trigger
language plpgsql set search_path = public as $$
declare m text[];
begin
  m := regexp_match(lower(coalesce(new.numero_ddt,'')), '(\d+)([a-z]?)');
  new.numero_chiave := case when m is null then nullif(regexp_replace(lower(coalesce(new.numero_ddt,'')), '[^a-z0-9]', '', 'g'), '')
                            else (m[1]::numeric)::text || m[2] end;
  new.aggiornato_il := now();
  -- un DDT protocollato non cambia azienda: il protocollo e' legato all'azienda
  if tg_op = 'UPDATE' and old.stato = 'protocollato' and new.azienda is distinct from old.azienda then
    raise exception 'Il DDT % e'' gia'' protocollato: l''azienda non si puo'' cambiare', old.protocollo;
  end if;
  return new;
end $$;
drop trigger if exists ddt_ricevuti_bu on public.ddt_ricevuti;
create trigger ddt_ricevuti_bu before insert or update on public.ddt_ricevuti
for each row execute function public.ddt_ricevuti_prima_di_salvare();

-- ---------------------------------------------------------------- sicurezza (stesse regole delle altre tabelle)
alter table public.ddt_ricevuti enable row level security;
alter table public.contatori_protocollo_ddt enable row level security;
alter table public.ddt_riferimenti_fatture enable row level security;

drop policy if exists solo_utenti_autorizzati on public.ddt_ricevuti;
create policy solo_utenti_autorizzati on public.ddt_ricevuti for all to authenticated
  using ((select public.is_autorizzato())) with check ((select public.is_autorizzato()));
drop policy if exists solo_utenti_autorizzati on public.contatori_protocollo_ddt;
create policy solo_utenti_autorizzati on public.contatori_protocollo_ddt for all to authenticated
  using ((select public.is_autorizzato())) with check ((select public.is_autorizzato()));
drop policy if exists solo_utenti_autorizzati on public.ddt_riferimenti_fatture;
create policy solo_utenti_autorizzati on public.ddt_riferimenti_fatture for all to authenticated
  using ((select public.is_autorizzato())) with check ((select public.is_autorizzato()));

revoke execute on function public.protocolla_ddt(uuid) from anon, public;
revoke execute on function public.abbina_ddt() from anon, public;
grant execute on function public.protocolla_ddt(uuid) to authenticated, service_role;
grant execute on function public.abbina_ddt() to authenticated, service_role;

-- ---------------------------------------------------------------- archivio file (privato)
insert into storage.buckets (id, name, public) values ('ddt-ricevuti', 'ddt-ricevuti', false)
on conflict (id) do nothing;
