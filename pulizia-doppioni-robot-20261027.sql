-- Pulizia delle fatture di vendita doppie create dal Robot SDI dal 23 al 27/10/2026.
-- Da incollare ed eseguire tutto insieme in Supabase -> SQL Editor.
-- Prima salva tutto in tabelle backup_doppioni_robot_*_20261027, poi cancella solo le copie "Madame Pivot"
-- che hanno un originale "MADAME PIVOT SRL" con lo stesso id del gestionale. Gli originali restano intatti.

begin;
create temp table dup on commit drop as
  select c.id, o.id orig_id, c.id_freeinvoice from fatture_vendita c
  join fatture_vendita o on o.id_gestionale = c.id_gestionale and o.azienda = 'MADAME PIVOT SRL'
  where c.azienda = 'Madame Pivot';

create table backup_doppioni_robot_fatture_20261027 as select f.* from fatture_vendita f where f.id in (select id from dup);
create table backup_doppioni_robot_righe_20261027 as select r.* from righe_fattura_vendita r where r.fattura_id in (select id from dup);
create table backup_doppioni_robot_pn_20261027 as select p.* from prima_nota p where p.origine_tabella = 'fattura_vendita' and p.origine_id in (select id from dup);
create table backup_doppioni_robot_pnr_20261027 as select r.* from prima_nota_righe r where r.prima_nota_id in (select id from backup_doppioni_robot_pn_20261027);
create table backup_doppioni_robot_fi_originali_20261027 as select o.id, o.id_freeinvoice from fatture_vendita o where o.id in (select orig_id from dup where id_freeinvoice is not null);

-- l'ID Freeinvoice che stava solo sulla copia passa all'originale
update fatture_vendita o set id_freeinvoice = d.id_freeinvoice
from dup d where o.id = d.orig_id and o.id_freeinvoice is null and d.id_freeinvoice is not null;

-- scritture di prima nota delle copie (le righe si cancellano in cascata), poi le copie (righe fattura in cascata)
delete from prima_nota where origine_tabella = 'fattura_vendita' and origine_id in (select id from dup);
delete from fatture_vendita where id in (select id from dup);
commit;

-- controllo: attesi 181 / 799 / 181 / ... e poi 0, 0, 0
select (select count(*) from backup_doppioni_robot_fatture_20261027) fatture_salvate,
       (select count(*) from backup_doppioni_robot_righe_20261027) righe_salvate,
       (select count(*) from backup_doppioni_robot_pn_20261027) prima_nota_salvate,
       (select count(*) from backup_doppioni_robot_pnr_20261027) righe_prima_nota_salvate,
       (select count(*) from fatture_vendita c where c.azienda = 'Madame Pivot'
          and exists (select 1 from fatture_vendita o where o.azienda = 'MADAME PIVOT SRL' and o.id_gestionale = c.id_gestionale)) doppioni_rimasti,
       (select count(*) from righe_fattura_vendita where fattura_id in (select id from backup_doppioni_robot_fatture_20261027)) righe_rimaste,
       (select count(*) from prima_nota where id in (select id from backup_doppioni_robot_pn_20261027)) prima_nota_rimaste;
