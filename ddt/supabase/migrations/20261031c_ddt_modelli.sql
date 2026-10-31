-- Lettura gratuita dei DDT: il programma impara, per ogni fornitore, dove stanno numero e data
-- (le parole che li precedono) dal primo DDT confermato a mano.

create table if not exists public.ddt_modelli (
  fornitore_piva text primary key,
  fornitore_denominazione text,
  ancora_numero text,          -- parole prima del numero DDT (es. "documento di trasporto n")
  ancora_data text,            -- parole prima della data DDT (es. "data documento")
  azienda_predefinita text,
  esempi int not null default 0,
  aggiornato_il timestamptz not null default now()
);
alter table public.ddt_modelli enable row level security;
drop policy if exists utenti_ddt on public.ddt_modelli;
create policy utenti_ddt on public.ddt_modelli for all to authenticated
  using ((select public.is_utente_ddt())) with check ((select public.is_utente_ddt()));
comment on table public.ddt_modelli is 'Come leggere i DDT di ogni fornitore (imparato dai DDT confermati nel programma DDT ricevuti).';

alter table public.ddt_ricevuti add column if not exists testo_letto text;
comment on column public.ddt_ricevuti.testo_letto is 'Testo estratto dal file (PDF o OCR) usato per la lettura e per imparare il modello del fornitore.';
