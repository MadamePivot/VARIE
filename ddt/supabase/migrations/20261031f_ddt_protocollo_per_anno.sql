-- Protocollo per azienda e ANNO DELLA DATA DEL DDT (non anno di caricamento), in ordine di data.
alter table ddt_ricevuti add column if not exists protocollo_precedente text;

-- protocolla_ddt: anno = anno della data DDT (se manca: anno corrente); date assurde rifiutate
create or replace function public.protocolla_ddt(p_id uuid) returns text
language plpgsql set search_path = public as $$
declare d ddt_ricevuti; a int; n int; prot text;
begin
  select * into d from ddt_ricevuti where id = p_id for update;
  if not found then raise exception 'DDT non trovato'; end if;
  if d.stato = 'protocollato' then return d.protocollo; end if;
  if d.azienda is null then raise exception 'Scegli l''azienda prima di protocollare'; end if;
  a := coalesce(extract(year from d.data_ddt)::int, extract(year from now() at time zone 'Europe/Rome')::int);
  if a < 2000 or a > extract(year from now())::int + 1 then
    raise exception 'La data del DDT (%) non sembra giusta: correggila prima di protocollare', d.data_ddt;
  end if;
  insert into contatori_protocollo_ddt (azienda, anno, ultimo_numero) values (d.azienda, a, 1)
  on conflict (azienda, anno) do update set ultimo_numero = contatori_protocollo_ddt.ultimo_numero + 1
  returning ultimo_numero into n;
  update ddt_ricevuti set stato = 'protocollato', anno_protocollo = a, numero_protocollo = n,
         protocollato_il = now(), aggiornato_il = now()
   where id = p_id returning protocollo into prot;
  perform abbina_ddt();
  return prot;
end $$;

-- Rinumera tutto (da lanciare a mano quando sono stati caricati tutti i DDT):  select * from rinumera_protocolli_ddt();
create or replace function public.rinumera_protocolli_ddt() returns table (azienda text, anno int, ddt int)
language plpgsql set search_path = public as $$
begin
  update ddt_ricevuti set protocollo_precedente = protocollo where stato='protocollato' and protocollo_precedente is null;
  with ord as (
    select d.id,
           coalesce(extract(year from d.data_ddt)::int, extract(year from d.protocollato_il at time zone 'Europe/Rome')::int) a,
           row_number() over (partition by d.azienda, coalesce(extract(year from d.data_ddt)::int, extract(year from d.protocollato_il at time zone 'Europe/Rome')::int)
                              order by d.data_ddt nulls last, d.protocollato_il, d.id) n
    from ddt_ricevuti d where d.stato='protocollato'
  )
  update ddt_ricevuti d set anno_protocollo = o.a, numero_protocollo = -o.n from ord o where d.id=o.id;
  update ddt_ricevuti set numero_protocollo = -numero_protocollo where stato='protocollato' and numero_protocollo < 0;
  delete from contatori_protocollo_ddt;
  insert into contatori_protocollo_ddt (azienda, anno, ultimo_numero)
    select x.azienda, x.anno_protocollo, max(x.numero_protocollo) from ddt_ricevuti x where x.stato='protocollato' group by 1,2;
  return query select c.azienda, c.anno, c.ultimo_numero from contatori_protocollo_ddt c order by 1,2;
end $$;
revoke execute on function public.rinumera_protocolli_ddt() from anon, public, authenticated;
