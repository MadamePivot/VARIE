# DDT ricevuti — Madame Pivot / MP Spazio Lab

Programma separato (non fa parte del gestionale principale) per:

1. **caricare** i DDT dei fornitori: trascinandoli nella pagina, scegliendo una cartella o mandandoli a `madamepivotdocuments@gmail.com` con **DDT** nell'oggetto;
2. **leggerli gratis**, senza AI a pagamento: testo del PDF oppure OCR (Tesseract) per scansioni e foto, direttamente nel browser.
   Riconosce azienda e fornitore dalle partite IVA; numero e data li trova tra i DDT attesi dalle fatture,
   oppure con il modello **imparato** per quel fornitore (dal primo DDT confermato a mano in poi);
3. **protocollarli** per azienda e anno: `MP-2026-0001`, `LAB-2026-0001`…;
4. **archiviarli** (cartella privata `ddt-ricevuti` su Supabase);
5. **spuntare** i DDT citati nelle fatture d'acquisto 2026 (scheda *DDT attesi dalle fatture*).

## File

| File | Cosa è |
|---|---|
| `ddt-ricevuti.html` | il programma: si apre con un doppio clic nel browser |
| `postino-ddt.gs` | lo script per la casella Gmail (etichette *DDT da protocollare* / *DDT protocollato*) |
| `supabase/functions/ddt-ricevuti/` | la funzione sul server (ricezione email, elenco DDT attesi), già pubblicata |
| `supabase/migrations/` | le tabelle, già create nel database |

## Da fare una volta sola

1. **Parola segreta del postino**: Supabase › Edge Functions › Secrets › aggiungi `DDT_POSTINO_TOKEN` con una parola lunga inventata (es. 30 caratteri a caso).
2. **Script Gmail**: entra come madamepivotdocuments@gmail.com, apri script.google.com, nuovo progetto, incolla `postino-ddt.gs`, aggiungi la proprietà script `DDT_POSTINO_TOKEN` (stessa parola del punto 1), esegui `installa`.
3. **Utente che userà il programma** (vede solo i DDT, non fatture/banche/buste paga):
   Supabase › Authentication › Users › *Invite user* con la sua email, poi nell'SQL editor:
   ```sql
   insert into utenti_ddt (user_id, email)
   select id, email from auth.users where email = 'sua@email.it';
   ```

## Come impara

- Prima volta di un fornitore: il programma riconosce fornitore, azienda e di solito la data; se il numero manca lo scrivi tu.
- Quando premi **Protocolla**, si segna dove quel fornitore stampa numero e data (parole prima del valore, o intestazione della colonna).
- Dal DDT successivo dello stesso fornitore li compila da solo. Si può sempre correggere prima di protocollare.
- Le scansioni vengono lette dall'OCR nel computer di chi usa il programma: qualche secondo a pagina, nessun costo.
- I DDT arrivati per email vengono letti la prima volta che si apre il programma.

## Come funziona il protocollo

- Il numero si assegna solo quando si preme **Protocolla e archivia** (o *Protocolla tutti quelli completi*): niente buchi nella numerazione per i documenti scartati.
- Numerazione separata per azienda, riparte ogni anno.
- Un DDT protocollato non può cambiare azienda.
- Lo stesso file caricato due volte viene riconosciuto e non duplicato.

## DDT attesi dalle fatture

- Vengono letti dalle **righe** delle fatture d'acquisto dal 1/1/2026 (es. "Rif. DDT 0000034 del 16/01/2026").
- Si spuntano da soli quando si protocolla un DDT con stessa azienda, stesso fornitore (P.IVA), stesso numero e stessa data; si possono spuntare a mano.
- "Rif. VS DDT" = DDT nostri (conto lavoro): nascosti di default.
- Limite: le fatture che indicano il DDT solo nel blocco XML `DatiDDT` (e non nelle righe) oggi non vengono viste, perché l'import delle fatture non salva quel blocco.
- L'elenco si aggiorna col pulsante *Aggiorna dalle fatture* e ogni mattina dallo script Gmail.
