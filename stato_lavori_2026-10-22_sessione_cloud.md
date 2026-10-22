# Stato lavori al 22/10/2026, sessione cloud (scarti fornitori e clienti)

Continua da `PASSAGGIO_NUOVA_CHAT_2026-10-22.md` e `stato_lavori_2026-10-22.md`.
Questa sessione girava nel cloud, quindi senza accesso ai file del Mac e al browser del gestionale. Ha lavorato solo sul database Supabase (`qwexiqicubanmodaebua`).
Tutte le scritture nuove sono in **bozza** e hanno una tabella di backup per annullarle.

## Regole nuove decise oggi dall'utente
- **Comanda l'estratto conto.** Se l'importo in banca e un altro dato non coincidono, vale l'estratto (es. bonifico a Centro Studi del 21/10/2026: 3.710 €, non 4.000).
- **Fino a fine 2021 controllare sempre Mexal** (tabella `mastrini_mexal`). La SRL è partita il 03/05/2021 in continuità con la ditta individuale. Le fatture della vecchia ditta pagate dalla SRL vanno su **95.0007** (giroconto SRL / ditta), non sul fornitore.
- **Agenti e incaricate:** quando versano i contanti incassati è un'**entrata** (NOTU, conti 86.0059-64). Quando la SRL paga la loro notula o fattura è un'**uscita** (costo provvigioni).
- **MP Spazio Lab** è la consociata che lavora per Madame Pivot.
- **Galati / Bandoneon:** Galati aveva un debito come cliente. Madame Pivot ha ripreso lo stock e lei lo fattura ogni mese (#0001…#0015). #0001 + #0002 sono state compensate con i suoi debiti (15.575 €) e lei ha saldato 51 € con un bonifico il 10/11/2025. #0003-#0008 sono state rimborsate nel 2026. Restano da pagare 15.225 € (#0009-#0015 + 480 € dell'ultimo pacco).
- **Saltati per decisione dell'utente:** Giorgio Alduini (+25,5k), Facchini / My Mary Jane (-9,6k fornitore e 86.0061), Marchesan responsabile negozio 86.0059 (-29k).

## Risultato principale: scarto fornitori 83.0001 (Madame Pivot SRL)
Lo scarto è la differenza fra il saldo teorico a fine 2025 (apertura 2021 + movimenti 2021-2025) e l'apertura Mexal 2026.
**Da -281k a -55,4k.** Le voci grosse che restano sono spiegate:
- MP Spazio Lab -27,3k: è solo la data della fattura FPR 14/25 del 31/12/2025, che Mexal ha registrato nel 2026. Va decisa con l'apertura (vedi "Decisioni aperte").
- Alduini +25,5k e Facchini -9,6k: saltati.
- Il resto, circa -44k, è sparso su tanti fornitori piccoli (gruppo E "chiuse su Mexal", ~7,5k, più differenze di nome).

Nota: lo scarto clienti -460k del passaggio era in gran parte di **MP Spazio Lab** (-405k di incassi senza fatture caricate, è un'altra società). Per Madame Pivot lo scarto clienti era -57k, oggi -72k dopo la compensazione Galati (vedi sotto).

## Lavori fatti (in ordine) e come annullarli
Per annullare una scrittura nuova: `delete from prima_nota_righe where prima_nota_id in (select pn_id from <backup>); delete from prima_nota where id in (select pn_id from <backup>);`
Per le righe riclassificate o rinominate: rimettere `conto` e `controparte` dalla tabella di backup (colonna `id` = id della riga).

| # | Cosa | Importo | Tabella di backup |
|---|---|---|---|
| A | Furgoni Ford: fatture Authos + CA Auto Bank chiuse sul debito di finanziamento. Dare 83.0001 / Avere **86.0076 Finanziamento CA Autobank** (10 scritture) | 82.809,61 | `backup_furgoni_ca_auto_nuove_20261022` |
| A | Rate SDD CA Auto 2024-2025 spostate da 81.0002/83.0001 a 86.0076 (48 righe). **86.0076 a fine 2025 = -67.730,33, uguale all'apertura** | 15.079,28 | `backup_furgoni_ca_auto_righe_20261022` |
| A | Rate SDD CA Auto 2026 (confermate) spostate da 81.0002 a 86.0076 (20 righe) | 6.279,70 | `backup_furgoni_ca_auto_righe2026_20261022` |
| B | IVA autofatture reverse charge TD17/TD19: Dare 83.0001 / Avere 84.0002 (229 scritture) | 17.857,19 | `backup_rc_iva_nuove_20261022` |
| C | Ritenute trattenute ai fornitori: Dare 83.0001 / Avere 84.0005 (IRPEF) + 83.0004 (INPS di Marchesan) (52 scritture) | 16.988,58 | `backup_ritenute_nuove_20261022` |
| — | MP Spazio Lab: 26 righe su 83.0001 con il nome "Spazio Lab" ma di altro (giroconti MyPOS/Viva/PayPal → 95.0007/95.0005/95.0006; incassi clienti → 83.0002; carte Facebook/Google, Bettarini, Formificio, Toscana Mignon, Fedex → fornitore giusto) | 33.510 + 3.270 | `backup_spaziolab_righe_20261022` (lavoro: `lav_spaziolab_righe_20261022`) |
| — | Arnia: 3 bonifici BLT del 2021 mai scritti che chiudono il debito di apertura (fatt. 5, 6, 16, 17, 22, 23). **Arnia a 0** | 22.220,50 | `backup_arnia_apertura_nuove_20261022` |
| — | Arnia fatt. 30 e 31 (fine aprile 2021, della ditta) pagate dalla SRL il 16/07/2021: Dare 95.0007 / Avere BLT | 12.374,50 | `backup_arnia_ditta_nuova_20261022` |
| — | Marchesan fornitrice: bonifico 01/02/2022 da 1.743 mai scritto + ritenute IRPEF/INPS di 12 fatture (3/2021, 1-11/2022). **Marchesan fornitrice a 0** | 1.743 + 5.387,85 | `backup_marchesan_nuove_20261022` |
| — | Centro Studi S.G. 2002: 3 bonifici 2021 con il solo IBAN …1282 rinominati + 4.000 € pagati il 03/05/2021 dal conto della ditta (Dare 83.0001 / Avere 95.0007). **Centro Studi a fine 2025 = apertura** | 12.300 + 4.000 | `backup_centrostudi_righe_20261022`, `backup_centrostudi_nuova_20261022` |
| — | Galati fornitrice: 3 autofatture TD18 doppie (2/66, 2/67, 2/91) ridotte alla sola IVA + compensazione EXP0001+EXP0002 con il credito cliente (11/11/2025). **Galati fornitrice -2.025 = apertura** | 21.472 + 15.575 | `backup_galati_nuove_20261022` |
| — | Galati cliente: 22 righe (note di credito "XXXXXXX"/"DE284668507" e 685 € "DA ABBINARE") rinominate MARIA GALATI-NEIDL | 3.702 | `backup_galati_cliente_righe_20261022` |
| — | Galati cliente: fattura 779 del 31/05/2022 chiusa come abbuono (87.0001) al 31/12/2025. **Galati cliente 75 € = apertura** (residuo fatt. 736) | 150 | `backup_galati_abbuono_20261022` |
| — | Bonifici BLT 2021 mai scritti, verificati sui PG di Mexal: BRT ×3, TMC Maxi, V.S. Pasqualini, Scatolificio Simone ×2, GLS → fornitori; Kosanke Alina 445 € = rimborso NC 333 al cliente (83.0002) | 3.601,43 | `backup_pag2021_mexal_nuove_20261022` |
| — | Berdini Alvise 230,53 e Cano Huaman 823,50 (fatture della vecchia ditta pagate dalla SRL): Dare 95.0007 / Avere BLT | 1.054,03 | `backup_ditta_pagate_srl_nuove_20261022` |
| — | Spesa POS "uscita a vuoto" 50 € del 28/12/2021 (lo storno del 30/12 c'era già): su 95.0002 | 50 | `backup_spesa50_20261022` |
| — | **Notule agenti** Forconi, Lazzari, Vergara, Visentin, Schiavon 2021-2025, dalla tabella `notule` del programma: 92 notule (Dare 63.0003 lordo / Avere 84.0005 ritenuta + 83.0001 netto) e 85 bonifici "saldo notula" mai scritti (Dare 83.0001 / Avere BLT). Saldi agenti a fine 2025: 0, tranne Visentin -77,93 (probabilmente una notula pagata in contanti) | 49.458 lordo, 40.507 pagati | `backup_notule_agenti_nuove_20261022` |

Altri effetti:
- **82.0001 BLT** ha circa 80k di uscite in più (Arnia, Marchesan, 2021, notule), quindi è più vicino al saldo reale.
- **84.0005** (~27,1k registrati oggi) e **83.0004** (~4,1k registrati oggi) hanno ritenute "da versare", che si chiudono con gli F24 quando arriva il riepilogo del consulente.
- **95.0007** (SRL/ditta): SRL che paga per la ditta 13.428,53 (Arnia 12.374,50 + Berdini + Cano Huaman); ditta che paga per la SRL 4.000 (Centro Studi).

## Decisioni aperte / per il commercialista
1. **Interessi e assicurazioni CA Auto** (fatture 0000023100049122 e …166, 38,9k) registrati in Dare 81.0001 e non a costo: va deciso se ripartirli sugli anni del finanziamento (risconto). Testo per il riepilogo già scritto in chat.
2. **FPR 14/25 MP Spazio Lab** (27.311,50, 31/12/2025): è in prima nota 2025 ma non nell'apertura Mexal 2026. Quando si decide il trattamento dell'apertura va registrata anche nel 2026, altrimenti il debito 2026 verso Spazio Lab risulta più basso.
3. **95.0007**: le partite SRL/ditta sopra vanno nel riepilogo della ditta.
4. **Gruppo D residuo** (autofatture TD16/TD18 doppie, ~3,4k oltre Galati) e **22 autofatture reverse charge** con importi non coincidenti (~1,2k): da vedere una per una.
5. **Gruppo E** (fatture "chiuse su Mexal" senza pagamento in banca, ~7,5k su 55 fornitori piccoli: Meta, alberghi, ristoranti, TIM, UPS…): probabilmente pagate con carta o in contanti. Non toccate.
6. **Abbinamento nel programma delle 28 fatture Galati 2024-2025 (15.626 €)** alla compensazione e al bonifico da 51 €: la tabella `pagamenti_fatture` ha due trigger che creano scritture da soli (`pn_giro_anticipo`, `trg_pn_auto_pagamento_fornitore`), quindi vanno letti e provati su una fattura sola prima di farlo.

## Dove ero arrivato: scarto clienti 83.0002 (-72k)
- Il dettaglio per cliente è sporco perché molte righe sono registrate sotto nomi non veri:
  - `import_gestionale_pagamenti` con controparte "XXXXXXX": 1.838 righe, -601k. Nella descrizione c'è "Incasso fatt. sez/numero NOME (gest id)", e la tabella `import_gestionale_pagamenti` ha `id_fattura`.
  - movimenti "DA ABBINARE": 406 righe, -130k, di cui 309 liquidazioni Viva delle vendite con carta (-123k, incassi cumulativi del sito, non attribuibili a un cliente).
  - fatture e note di credito "XXXXXXX": 622 righe, -89k.
  - controparte vuota: corrispettivi mensili +90k, gift +17k, PayPal -20k.
- Ci sono clienti con crediti molto più alti dell'apertura Mexal: **Liu Sarah +132k**, **Hyesung Jin (Madame Pivot Korea) +105k**, **Rapanova Oksana +80k**, e circa +11k ciascuno per Messina, Detangosetrata, Galkina, Makhno, Tangostore, Tina De Marco, Incanto/Iannice, Clave Loca, Papadopoulou, Desrosiers. Quasi certamente i loro incassi e le loro note di credito sono sotto "XXXXXXX" o "DA ABBINARE", come per Galati.
- **Prossimo passo (solo rinomina, nessun importo cambia):**
  1. dare alle righe di fatture e NC il nome del cliente del documento collegato (tabella di lavoro già pronta: `lav_cli_nomi_20261022`, 520 righe, **non ancora applicata**);
  2. dare alle righe `import_gestionale_pagamenti` il nome dalla fattura (`id_fattura` o dalla descrizione);
  3. ricalcolare lo scarto per cliente e partire da Liu Sarah, Hyesung Jin e Rapanova.
- Tabella di lavoro preliminare (solo lettura): `lav_cli_rinomina_20261022`.

## Poi, nell'ordine chiesto dall'utente
2. Abbinare nel programma le fatture Galati 2024-2025 (punto 6 sopra).
3. Gli altri casi nota di credito + fattura dello stesso importo: Basilico, Vlachou, Detangosetrata, Lussmann, Zhu Xin (Galati fatto).

## Note tecniche
- Mastrini Mexal 2021-2026: `mastrini_mexal` (codice_conto, data_registrazione, tipo_documento PG/RL/NR/FE, dare, avere, contropartita) + `piano_conti_mexal` (codice → descrizione). I fornitori hanno codice `410.xxxxx`, i clienti `205.xxxxx`, la BLT `214.00118`.
- Notule degli agenti: tabella `notule` (lordo, ritenuta_imposta, totale_netto, agente_nome).
- I movimenti dell'estratto della **ditta individuale** 2021-2022 (`file_name` "estratto 202x ditta individuale…") sono volutamente senza scrittura: non toccarli.
- Le scritture di movimento nuove usano id = `md5('mb:'||movimento_id)`. Prima di scrivere controllare sempre che non esista già una scrittura con quell'`origine_id` o con quell'id.
- Le query lunghe su `prima_nota_righe` con regex vanno oltre i 60 secondi del tool: meglio dividerle in passi con tabelle `lav_*`.
