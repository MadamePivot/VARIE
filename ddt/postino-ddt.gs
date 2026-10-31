/**
 * POSTINO DDT — Google Apps Script per la casella madamepivotdocuments@gmail.com
 *
 * Cosa fa, da solo, ogni 10 minuti:
 *  1. cerca le email con "DDT" nell'oggetto e un allegato (PDF o foto) non ancora lavorate;
 *  2. manda ogni allegato al programma DDT (lo legge alla prossima apertura e lo mette in "Da confermare");
 *  3. mette all'email l'etichetta "DDT da protocollare";
 *  4. quando tutti i DDT di quell'email sono stati protocollati nel programma,
 *     sposta l'email sull'etichetta "DDT protocollato".
 * Una volta al giorno aggiorna anche l'elenco dei DDT attesi dalle fatture.
 *
 * INSTALLAZIONE (una volta sola, entrando come madamepivotdocuments@gmail.com):
 *  - vai su https://script.google.com > Nuovo progetto, chiamalo "Postino DDT"
 *  - incolla tutto questo file al posto del contenuto
 *  - Impostazioni progetto (rotellina) > Proprietà script > Aggiungi:
 *        nome:   DDT_POSTINO_TOKEN
 *        valore: la stessa parola segreta salvata in Supabase (segreto DDT_POSTINO_TOKEN)
 *  - in alto scegli la funzione "installa" e premi Esegui; accetta le autorizzazioni richieste
 *  Fatto. Per provare subito: esegui "controllaPosta".
 */

const URL_FUNZIONE = 'https://qwexiqicubanmodaebua.supabase.co/functions/v1/ddt-ricevuti';
const ETICHETTA_DA = 'DDT da protocollare';
const ETICHETTA_OK = 'DDT protocollato';
const ETICHETTA_ERR = 'DDT errore';
const RICERCA = 'subject:ddt has:attachment newer_than:60d -label:"' + ETICHETTA_DA + '" -label:"' + ETICHETTA_OK + '" -label:"' + ETICHETTA_ERR + '"';
const TIPI = /\.(pdf|jpe?g|png|webp)$/i;

function installa() {
  [ETICHETTA_DA, ETICHETTA_OK, ETICHETTA_ERR].forEach(etichetta_);
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('controllaPosta').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('manutenzione').timeBased().everyDays(1).atHour(6).create();
  token_(); // controlla che la parola segreta ci sia
  Logger.log('Postino DDT installato: controllo ogni 10 minuti.');
}

function controllaPosta() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    riceviNuove_();
    aggiornaEtichette_();
  } finally {
    lock.releaseLock();
  }
}

function riceviNuove_() {
  const threads = GmailApp.search(RICERCA, 0, 20);
  threads.forEach(thread => {
    let errori = 0, inviati = 0;
    const mappa = leggiInviati_(), mieIds = [];
    thread.getMessages().forEach(msg => {
      msg.getAttachments({ includeInlineImages: false }).forEach(att => {
        const nome = att.getName() || 'allegato.pdf';
        const tipo = att.getContentType() || '';
        if (!TIPI.test(nome) && !/pdf|image\//i.test(tipo)) return;
        const r = chiama_({
          azione: 'ricevi',
          gmail_message_id: msg.getId(),
          nome_file: TIPI.test(nome) ? nome : nome + (/pdf/i.test(tipo) ? '.pdf' : '.jpg'),
          file_base64: Utilities.base64Encode(att.getBytes()),
          mittente: msg.getFrom(),
          oggetto: msg.getSubject(),
          ricevuta_il: msg.getDate().toISOString(),
        });
        if (r && (r.esito || r.ok)) { inviati++; if (r.esito !== 'ignorato' && mieIds.indexOf(msg.getId()) < 0) mieIds.push(msg.getId()); }
        else errori++;
        Logger.log(nome + ': ' + JSON.stringify(r));
      });
    });
    if (errori && !inviati) thread.addLabel(etichetta_(ETICHETTA_ERR));
    else if (inviati) {
      thread.addLabel(etichetta_(ETICHETTA_DA));
      mappa[thread.getId()] = mieIds;
      salvaInviati_(mappa);
    }
  });
}

// sposta su "DDT protocollato" le email i cui DDT sono stati tutti protocollati (o scartati)
function aggiornaEtichette_() {
  const da = etichetta_(ETICHETTA_DA), ok = etichetta_(ETICHETTA_OK);
  const inviati = leggiInviati_();
  const threads = da.getThreads(0, 100);
  if (!threads.length) return;
  const ids = [];
  threads.forEach(t => (inviati[t.getId()] || []).forEach(id => ids.push(id)));
  if (!ids.length) return;
  const r = chiama_({ azione: 'stato_email', ids: ids });
  if (!r || !r.protocollate) return;
  const fatte = new Set(r.protocollate.map(p => p.id));
  threads.forEach(t => {
    const mieIds = inviati[t.getId()] || [];
    if (mieIds.length && mieIds.every(id => fatte.has(id))) {
      t.removeLabel(da);
      t.addLabel(ok);
      delete inviati[t.getId()];
    }
  });
  salvaInviati_(inviati);
}

// quali messaggi di ogni conversazione hanno mandato DDT al programma
function leggiInviati_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('INVIATI') || '{}'); } catch (e) { return {}; }
}
function salvaInviati_(m) { PropertiesService.getScriptProperties().setProperty('INVIATI', JSON.stringify(m)); }

function manutenzione() {
  const r = chiama_({ azione: 'manutenzione' });
  Logger.log(JSON.stringify(r));
}

// ---------------------------------------------------------------- utilità
function chiama_(corpo) {
  corpo.token = token_();
  try {
    const res = UrlFetchApp.fetch(URL_FUNZIONE, {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(corpo), muteHttpExceptions: true,
    });
    const testo = res.getContentText();
    if (res.getResponseCode() >= 300) { Logger.log('Errore ' + res.getResponseCode() + ': ' + testo); return null; }
    return JSON.parse(testo);
  } catch (e) {
    Logger.log('Chiamata non riuscita: ' + e);
    return null;
  }
}
function token_() {
  const t = PropertiesService.getScriptProperties().getProperty('DDT_POSTINO_TOKEN');
  if (!t) throw new Error('Manca la proprieta\' DDT_POSTINO_TOKEN (Impostazioni progetto > Proprieta\' script)');
  return t;
}
function etichetta_(nome) {
  return GmailApp.getUserLabelByName(nome) || GmailApp.createLabel(nome);
}
