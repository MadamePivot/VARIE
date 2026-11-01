-- Riordino progressivi: un DDT scartato dopo il protocollo libera il suo numero
-- (il vecchio protocollo resta in protocollo_precedente come traccia).
create or replace function public.rinumera_protocolli_ddt()
 returns table(azienda text, anno integer, ddt integer)
 language plpgsql
 set search_path to 'public'
as $function$
begin
  update ddt_ricevuti set protocollo_precedente = coalesce(protocollo_precedente, protocollo), numero_protocollo = null
   where stato <> 'protocollato' and numero_protocollo is not null;
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
  delete from contatori_protocollo_ddt where true;
  insert into contatori_protocollo_ddt (azienda, anno, ultimo_numero)
    select x.azienda, x.anno_protocollo, max(x.numero_protocollo) from ddt_ricevuti x where x.stato='protocollato' group by 1,2;
  return query select c.azienda, c.anno, c.ultimo_numero from contatori_protocollo_ddt c order by 1,2;
end $function$;
