-- Pulsante "Riordina progressivi" del programma DDT: rinumera per data DDT (azienda e anno).
create or replace function public.riordina_progressivi_ddt() returns table (azienda text, anno int, ddt int)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_utente_ddt() then raise exception 'non autorizzato'; end if;
  return query select * from public.rinumera_protocolli_ddt();
end $$;
revoke execute on function public.riordina_progressivi_ddt() from anon, public;
grant execute on function public.riordina_progressivi_ddt() to authenticated;
