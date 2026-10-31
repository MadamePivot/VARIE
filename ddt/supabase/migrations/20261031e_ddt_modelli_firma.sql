alter table public.ddt_modelli add column if not exists firma text;
comment on column public.ddt_modelli.firma is 'Parole tipiche del modulo DDT del fornitore (JSON), per riconoscerlo anche quando nome e P.IVA sono solo nel logo.';
