-- elenco fornitori (solo nome e P.IVA) per gli utenti "solo DDT"
create or replace function public.ddt_elenco_fornitori()
returns table (piva text, nome text)
language sql stable security definer set search_path = '' as $$
  select distinct on (public.ddt_piva_norm(f.fornitore_piva))
         public.ddt_piva_norm(f.fornitore_piva), f.fornitore_denominazione
  from public.fatture f
  where public.is_utente_ddt() and f.fornitore_piva is not null and f.data >= date '2024-01-01'
    and public.ddt_piva_norm(f.fornitore_piva) not in ('07096860486','07376920489')
  order by public.ddt_piva_norm(f.fornitore_piva), f.data desc
$$;
revoke execute on function public.ddt_elenco_fornitori() from anon, public;
grant execute on function public.ddt_elenco_fornitori() to authenticated;

-- numero normalizzato: "1.331/V" -> "1331" (punti delle migliaia tolti)
create or replace function public.ddt_ricevuti_prima_di_salvare() returns trigger
language plpgsql set search_path = public as $$
declare m text[];
begin
  m := regexp_match(regexp_replace(lower(coalesce(new.numero_ddt,'')), '(\d)\.(?=\d)', '\1', 'g'), '(\d+)([a-z]?)');
  new.numero_chiave := case when m is null then nullif(regexp_replace(lower(coalesce(new.numero_ddt,'')), '[^a-z0-9]', '', 'g'), '')
                            else (m[1]::numeric)::text || m[2] end;
  new.aggiornato_il := now();
  if tg_op = 'UPDATE' and old.stato = 'protocollato' and new.azienda is distinct from old.azienda then
    raise exception 'Il DDT % e'' gia'' protocollato: l''azienda non si puo'' cambiare', old.protocollo;
  end if;
  return new;
end $$;

-- abbinamento: esclusi i nostri DDT citati nelle fatture ("Rif. VS DDT", conto lavorazione)
create or replace function public.abbina_ddt() returns int
language plpgsql set search_path = public as $$
declare n int;
begin
  update ddt_riferimenti_fatture r set ddt_ricevuto_id = d.id
  from ddt_ricevuti d
  where r.ddt_ricevuto_id is null
    and not r.ddt_nostro
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
