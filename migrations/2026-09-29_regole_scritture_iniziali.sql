-- Regole scritture iniziali (tutte con anteprima, non automatiche)
insert into regole_scritture (nome, azienda, origine, righe, priorita, note) values
('Fattura acquisto: costo + IVA a credito / debiti fornitori', null, 'fattura_acquisto',
 '[{"conto":"@RIGHE","lato":"dare","importo":"imponibile"},{"conto":"84.0001","lato":"dare","importo":"iva"},{"conto":"83.0001","lato":"avere","importo":"totale","partitario":true}]', 100,
 'Costo sul conto assegnato a ogni riga; note di credito con lati invertiti'),
('Fattura vendita: crediti clienti / ricavi + IVA a debito', null, 'fattura_vendita',
 '[{"conto":"83.0002","lato":"dare","importo":"totale","partitario":true},{"conto":"85.0001","lato":"avere","importo":"imponibile"},{"conto":"84.0002","lato":"avere","importo":"iva"}]', 100,
 'Note di credito con lati invertiti');

with c(azienda, origine, banca, numero_conto, conto, etichetta) as (values
 ('MADAME PIVOT SRL','movimento_banca','BANCO DI LUCCA','5293','82.0001','BLT 5293'),
 ('MADAME PIVOT SRL','movimento_banca','BANCO DI LUCCA','5648','82.0002','BLT 5648'),
 ('MADAME PIVOT SRL','movimento_banca','INTESA',null,'82.0003','Intesa'),
 ('MADAME PIVOT SRL','movimento_banca','FINECO',null,'82.0004','Fineco'),
 ('MADAME PIVOT SRL','movimento_banca','VIVA','8252','82.0005','Viva 8252'),
 ('MADAME PIVOT SRL','movimento_banca','VIVA','2488','82.0006','Viva 2488'),
 ('MADAME PIVOT SRL','movimento_banca','VIVA','9148','82.0007','Viva 9148'),
 ('MADAME PIVOT SRL','movimento_banca','PAYPAL',null,'82.0008','PayPal'),
 ('MADAME PIVOT SRL','movimento_banca','MYPOS',null,'82.0009','MyPOS'),
 ('MADAME PIVOT SRL','movimento_banca','AMERICAN EXPRESS',null,'82.0010','Amex conto'),
 ('MADAME PIVOT SRL','movimento_carta','9482',null,'82.0011','Carta 9482'),
 ('MADAME PIVOT SRL','movimento_carta','AMERICAN EXPRESS',null,'82.0012','Carta Amex'),
 ('MP SPAZIO LAB SRL','movimento_banca','BANCO DI LUCCA','1915','82.0101','BLT 1915'),
 ('MP SPAZIO LAB SRL','movimento_carta','8069',null,'82.0102','Carta 8069')),
t(suffisso, verso, coll, prio, lato_x, importo_x, conto_x, partitario, nome) as (values
 ('pagamento fornitore','dare','acquisto',110,'dare','importo','83.0001',true,'Pagamento fornitore'),
 ('incasso cliente','avere','vendita',110,'avere','importo','83.0002',true,'Incasso cliente'),
 ('uscita con conto','dare','nessuno',200,'dare','importo','@MOVIMENTO',false,'Uscita sul conto assegnato'),
 ('entrata con conto','avere','nessuno',200,'avere','importo','@MOVIMENTO',false,'Entrata dal conto assegnato'))
insert into regole_scritture (nome, azienda, origine, banca, numero_conto, verso, collegamento, righe, priorita, note)
select t.nome || ' — ' || c.etichetta, c.azienda, c.origine, c.banca, c.numero_conto, t.verso, t.coll,
  jsonb_build_array(
    case when t.verso='dare'
      then jsonb_build_object('conto', t.conto_x, 'lato','dare','importo','importo') || case when t.partitario then '{"partitario":true}'::jsonb else '{}'::jsonb end
      else jsonb_build_object('conto', c.conto, 'lato','dare','importo','importo') end,
    case when t.verso='dare'
      then jsonb_build_object('conto', c.conto, 'lato','avere','importo','importo')
      else jsonb_build_object('conto', t.conto_x, 'lato','avere','importo','importo') || case when t.partitario then '{"partitario":true}'::jsonb else '{}'::jsonb end end),
  t.prio, 'Creata dalle regole iniziali'
from c cross join t
where not (c.origine='movimento_carta' and t.coll='vendita');
