// Edge Function: importa-xml-fatture — IMPORTATORE UNICO delle fatture elettroniche (v7)
//
// Usato da:
//  - il robot notturno (Cloud Finance / Free Invoice, GitHub Actions)  -> header x-import-token
//  - la scheda "Carica" dell'app Fatture Vendita                       -> login utente autorizzato (non basta piu' la chiave pubblica)
//
//   POST /functions/v1/importa-xml-fatture
//   { "fonte": "...", "modalita": "salva" | "anteprima", "files": [ { "fileName": "IT...xml", "xml": "<?xml ..." } ] }
//
// Le regole di lettura sono in nucleo.ts (unione del parser del robot e di quello dell'app).
// Fatture gia' presenti (stessa azienda + numero + data): non vengono duplicate; se mancano dei dati
// (sezionale, nazione, comune, cliente, dettagli righe) vengono COMPLETATI dall'XML, senza mai
// sovrascrivere un campo gia' compilato. Eccezione: le fatture caricate incomplete dal robot a partire
// dall'11/10/2026 (senza sezionale e senza cliente) ricevono anche imponibile/IVA/totale e P.IVA
// calcolati con le regole dell'app (prima l'IVA OSS risultava 0).
//
// 01/11/2026: per le fatture d'acquisto salva anche i DDT del blocco <DatiDDT> in fatture_dati_ddt
// (usati dal programma DDT ricevuti). Se il salvataggio dei DDT non riesce la fattura e' importata lo stesso.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { DOMParser } from "npm:@xmldom/xmldom@0.8.10";
import { leggiFatture, datiVendita, costruisciCatalogo, chiaveCliente, type Catalogo, type Fattura, type Anagrafica } from "./nucleo.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const IMPORT_XML_TOKEN = Deno.env.get("IMPORT_XML_TOKEN");

const AZIENDA_ACQUISTI = "MADAME PIVOT SRL";
const AZIENDA_VENDITE = "Madame Pivot";
const AZIENDA_FATTURE_VENDITA = "MADAME PIVOT SRL"; // nome sulla testata fatture_vendita (righe e clienti restano AZIENDA_VENDITE)
const MAX_FILES = 200;
const INIZIO_ROBOT = "2026-10-11T00:00:00Z"; // da qui il robot ha caricato fatture incomplete

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-import-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
function uguali(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// la chiave pubblica dell'app e' valida se Supabase la accetta per questo progetto (verifica in cache)
const chiaviValide = new Set<string>();
async function chiaveDelProgetto(k: string): Promise<boolean> {
  if (!k || k.length < 20) return false;
  if (chiaviValide.has(k)) return true;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/modelli_calzature?select=id_esterno&limit=1`, { headers: { apikey: k, Authorization: `Bearer ${k}` } });
    if (r.ok) { chiaviValide.add(k); return true; }
  } catch (_) { /* rete */ }
  return false;
}

// ---------------- catalogo modelli (cache 10 minuti) ----------------
let catalogoCache: { cat: Catalogo; at: number } | null = null;
async function catalogo(): Promise<Catalogo> {
  if (catalogoCache && Date.now() - catalogoCache.at < 600_000) return catalogoCache.cat;
  const { data: modelli } = await supabase.from("modelli_calzature").select("nome_interno, nome_cliente, genere, id_esterno").eq("azienda", AZIENDA_VENDITE);
  const varianti: unknown[] = [];
  for (let da = 0; ; da += 1000) {
    const { data, error } = await supabase.from("varianti_colore_modello")
      .select("id_modello_base_esterno, descrizione_it, descrizione_it_norm, descrizione_en_norm")
      .eq("azienda", AZIENDA_VENDITE).range(da, da + 999);
    if (error || !data || !data.length) break;
    varianti.push(...data);
    if (data.length < 1000) break;
  }
  const cat = costruisciCatalogo(modelli || [], varianti);
  catalogoCache = { cat, at: Date.now() };
  return cat;
}

// ---------------- anagrafiche ----------------
async function arricchisciAnagrafica(party: Anagrafica | null, isFornitore: boolean) {
  if (!party || !party.idCodicePiva) return;
  const payload: Record<string, unknown> = {
    azienda: AZIENDA_ACQUISTI, piva_cf: party.idCodicePiva, ragione_sociale: party.denom || null,
    indirizzo: party.indirizzo || null, cap: party.cap || null, comune: party.comune || null,
    provincia: party.provincia || null, nazione: party.nazione || null,
  };
  if (isFornitore) payload.regime_fiscale = party.regimeFiscale || null;
  else { payload.codice_destinatario = party.codiceDestinatario || null; payload.pec = party.pec || null; }
  const { error } = await supabase.from("anagrafiche_contatti").upsert(payload, { onConflict: "azienda,piva_cf" });
  if (error) console.error("Errore arricchimento anagrafica:", error);
}

// cliente in clienti_vendita, con la stessa regola dell'app
async function clienteVendita(t: Record<string, unknown>): Promise<string> {
  const chiave = chiaveCliente(t.cliente_piva as string, t.cliente_cf as string);
  if (chiave) {
    const { data: es, error } = await supabase.from("clienti_vendita").select("id")
      .eq("azienda", AZIENDA_VENDITE).eq("chiave_dedup", chiave).maybeSingle();
    if (error) throw error;
    if (es) return es.id as string;
  }
  const { data: nuovo, error: errIns } = await supabase.from("clienti_vendita").insert({
    denominazione: t.cliente_denominazione, piva: t.cliente_piva, codice_fiscale: t.cliente_cf,
    comune: t.cliente_comune, nazione: t.cliente_nazione,
    chiave_dedup: chiave || ("SENZA-ID-" + crypto.randomUUID()), azienda: AZIENDA_VENDITE,
  }).select("id").single();
  if (errIns) throw errIns;
  return nuovo.id as string;
}

// ---------------- vendite ----------------
async function trovaVendita(f: Fattura) {
  const numeri = [...new Set([f.numero, f.numeroRaw, f.sezionale && f.numero ? `${f.sezionale}/${f.numero}` : null].filter(Boolean))] as string[];
  const { data } = await supabase.from("fatture_vendita")
    .select("id, sezionale, cliente_nazione, cliente_comune, cliente_id, cliente_cf, created_at")
    .in("azienda", [AZIENDA_FATTURE_VENDITA, AZIENDA_VENDITE]).eq("data", f.data).in("numero", numeri);
  const lista = data || [];
  return lista.find((e) => e.sezionale === f.sezionale) || lista.find((e) => !e.sezionale) || null;
}

const CAMPI_RIGA_DA_COMPLETARE = ["unita_misura", "natura", "aliquota_oss", "importo_oss", "codice_articolo", "codice_conto",
  "modello", "taglia", "altezza_tacco", "calzata", "modello_base_report", "variante_report", "genere_report"];

async function completaVendita(e: Record<string, unknown>, f: Fattura, cat: Catalogo) {
  const { testata, righe } = datiVendita(f, cat);
  const agg: Record<string, unknown> = {};
  if (!e.sezionale && testata.sezionale) agg.sezionale = testata.sezionale;
  if (!e.cliente_nazione && testata.cliente_nazione) agg.cliente_nazione = testata.cliente_nazione;
  if (!e.cliente_comune && testata.cliente_comune) agg.cliente_comune = testata.cliente_comune;
  if (!e.cliente_cf && testata.cliente_cf) agg.cliente_cf = testata.cliente_cf;
  const daRobotIncompleta = !e.sezionale && !e.cliente_id && String(e.created_at) >= INIZIO_ROBOT;
  if (daRobotIncompleta) {
    agg.imponibile = testata.imponibile; agg.imposta = testata.imposta; agg.importo_totale = testata.importo_totale;
    agg.cliente_piva = testata.cliente_piva;
  }
  if (!e.cliente_id) agg.cliente_id = await clienteVendita({ ...testata });
  let campi = Object.keys(agg).length;
  if (campi) {
    const { error } = await supabase.from("fatture_vendita").update(agg).eq("id", e.id);
    if (error) throw new Error("aggiornamento testata: " + error.message);
  }
  const { data: esistenti } = await supabase.from("righe_fattura_vendita")
    .select("id, numero_linea, " + CAMPI_RIGA_DA_COMPLETARE.join(", ")).eq("fattura_id", e.id);
  for (const r of (esistenti || []) as Record<string, unknown>[]) {
    const nuova = righe.find((x) => String(x.numero_linea) === String(r.numero_linea)) as Record<string, unknown> | undefined;
    if (!nuova) continue;
    const aggR: Record<string, unknown> = {};
    for (const c of CAMPI_RIGA_DA_COMPLETARE) if ((r[c] === null || r[c] === undefined) && nuova[c] != null) aggR[c] = nuova[c];
    if (Object.keys(aggR).length) {
      const { error } = await supabase.from("righe_fattura_vendita").update(aggR).eq("id", r.id);
      if (error) throw new Error("aggiornamento riga: " + error.message);
      campi += Object.keys(aggR).length;
    }
  }
  return campi;
}

async function salvaVendita(f: Fattura, cat: Catalogo): Promise<{ esito: "ok" | "saltata" | "completata" | "errore"; motivo?: string }> {
  const esistente = await trovaVendita(f);
  if (esistente) {
    const n = await completaVendita(esistente, f, cat);
    await arricchisciAnagrafica(f.cliente, false);
    return { esito: n ? "completata" : "saltata" };
  }
  const { testata, righe } = datiVendita(f, cat);
  const cliente_id = await clienteVendita({ ...testata });
  const { data: ins, error } = await supabase.from("fatture_vendita")
    .insert({ ...testata, cliente_id, azienda: AZIENDA_FATTURE_VENDITA }).select("id").single();
  if (error || !ins) return { esito: "errore", motivo: "inserimento fattura: " + (error?.message || "nessuna riga") };
  if (righe.length) {
    const { error: errR } = await supabase.from("righe_fattura_vendita")
      .insert(righe.map((r) => ({ ...r, fattura_id: ins.id, azienda: AZIENDA_VENDITE })));
    if (errR) {
      // niente fattura senza righe: si annulla solo l'inserimento appena fatto, il prossimo giro la riprova
      await supabase.from("fatture_vendita").delete().eq("id", ins.id);
      return { esito: "errore", motivo: "inserimento righe: " + errR.message };
    }
  }
  await arricchisciAnagrafica(f.cliente, false);
  return { esito: "ok" };
}

// ---------------- DDT citati nella fattura d'acquisto (blocco DatiDDT) ----------------
// Non blocca mai l'importazione: un errore qui viene solo scritto nel log della funzione.
async function salvaDatiDDT(fatturaId: unknown, f: Fattura) {
  if (!fatturaId || !f.datiDDT || !f.datiDDT.length) return;
  try {
    const righe = f.datiDDT.map((d) => ({
      fattura_id: fatturaId, numero_ddt: String(d.numero).slice(0, 60),
      data_ddt: d.data && /^\d{4}-\d{2}-\d{2}$/.test(d.data) ? d.data : null,
      linee: d.linee || null,
    }));
    for (const r of righe) {
      const { error } = await supabase.from("fatture_dati_ddt").insert(r);
      if (error && error.code !== "23505") console.error("DatiDDT non salvati:", error.message);
    }
  } catch (e) {
    console.error("DatiDDT non salvati:", e instanceof Error ? e.message : String(e));
  }
}

// ---------------- acquisti (logica del robot, invariata) ----------------
async function salvaAcquisto(f: Fattura): Promise<{ esito: "ok" | "saltata" | "errore"; motivo?: string }> {
  const { data: esistente } = await supabase.from("fatture")
    .select("id,data_scadenza_pagamento,metodo_pagamento_previsto,ritenuta_importo,pagato_altro")
    .eq("azienda", AZIENDA_ACQUISTI).eq("numero", f.numero).eq("data", f.data).limit(1).maybeSingle();
  if (esistente) {
    const agg: Record<string, unknown> = {};
    const e = esistente as Record<string, unknown>;
    if (!e.data_scadenza_pagamento && f.dataScadenza) agg.data_scadenza_pagamento = f.dataScadenza;
    if (!e.metodo_pagamento_previsto && f.metodoPagamentoPrevisto) agg.metodo_pagamento_previsto = f.metodoPagamentoPrevisto;
    if (!e.ritenuta_importo && f.ritenutaImporto) {
      agg.ritenuta_importo = f.ritenutaImporto; agg.ritenuta_causale = f.ritenutaCausale;
      if (!e.pagato_altro) { agg.pagato_altro = f.ritenutaImporto; agg.pagato_altro_note = "Ritenuta fiscale versata con F24"; }
    }
    if (Object.keys(agg).length) await supabase.from("fatture").update(agg).eq("id", e.id as number);
    await salvaDatiDDT(e.id, f);
    await arricchisciAnagrafica(f.fornitore, true);
    return { esito: "saltata" };
  }
  const { data: ins, error } = await supabase.from("fatture").insert({
    numero: f.numero, data: f.data, tipo_documento: f.tipoDocumento, importo_totale: f.importoTotale,
    divisa: f.divisa, fornitore_denominazione: f.fornitore.denom, fornitore_piva: f.fornitore.idCodicePiva,
    fornitore_cf: f.fornitore.cf, cliente_denominazione: f.cliente.denom, cliente_piva: f.cliente.idCodicePiva,
    cliente_cf: f.cliente.cf, file_name: f.fileName, azienda: AZIENDA_ACQUISTI,
    data_scadenza_pagamento: f.dataScadenza, metodo_pagamento_previsto: f.metodoPagamentoPrevisto,
    ritenuta_importo: f.ritenutaImporto, ritenuta_causale: f.ritenutaCausale,
    ...(f.ritenutaImporto ? { pagato_altro: f.ritenutaImporto, pagato_altro_note: "Ritenuta fiscale versata con F24" } : {}),
  }).select("id").single();
  if (error || !ins) return { esito: "errore", motivo: "inserimento fattura acquisto: " + (error?.message || "nessuna riga") };
  const righe = f.righe.map((l) => ({
    fattura_id: ins.id, numero_linea: l.numero_linea, descrizione: l.descrizione, quantita: l.quantita,
    prezzo_unitario: l.prezzo_unitario, aliquota_iva: l.aliquota_iva, prezzo_totale: l.prezzo_totale,
    riferimento_amministrazione: l.riferimento_amministrazione, azienda: AZIENDA_ACQUISTI,
    codice_conto: Number(l.prezzo_totale) === 0 ? "10000" : null,
  }));
  if (righe.length) {
    const { error: errR } = await supabase.from("righe_fattura").insert(righe);
    if (errR) {
      await supabase.from("fatture").delete().eq("id", ins.id);
      return { esito: "errore", motivo: "inserimento righe acquisto: " + errR.message };
    }
  }
  await salvaDatiDDT(ins.id, f);
  await arricchisciAnagrafica(f.fornitore, true);
  return { esito: "ok" };
}

// ---------------- endpoint ----------------
// ---- Sicurezza (16/10/2026): passano solo gli utenti in utenti_autorizzati, la service_role
// e i job pianificati del database (lasciapassare monouso x-cron-nonce creato da cron_chiama_funzione).
// La chiave pubblica (anon) da sola non basta piu'.
async function _verificaAccesso(req: Request): Promise<Response | null> {
  if (req.method === "OPTIONS") return null;
  const url = Deno.env.get("SUPABASE_URL")!, srv = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const no = (m: string) => new Response(JSON.stringify({ ok: false, error: "Non autorizzato: " + m }), {
    status: 401, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
  const h = { apikey: srv, Authorization: "Bearer " + srv, "Content-Type": "application/json" };
  try {
    const nonce = req.headers.get("x-cron-nonce");
    if (nonce) {
      const r = await fetch(`${url}/rest/v1/rpc/consuma_cron_nonce`, { method: "POST", headers: h, body: JSON.stringify({ p_nonce: nonce }) });
      return r.ok && (await r.json()) === true ? null : no("lasciapassare scaduto o gia' usato");
    }
    const tok = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!tok) return no("manca il login");
    if (tok === srv) return null;
    const u = await fetch(`${url}/auth/v1/user`, { headers: { apikey: srv, Authorization: "Bearer " + tok } });
    if (!u.ok) return no("serve il login di un utente");
    const user = await u.json();
    if (!user?.id) return no("utente non valido");
    const a = await fetch(`${url}/rest/v1/utenti_autorizzati?select=user_id&user_id=eq.${encodeURIComponent(user.id)}`, { headers: h });
    const righe = a.ok ? await a.json() : [];
    return Array.isArray(righe) && righe.length ? null : no("utente non abilitato");
  } catch (e) {
    return no("verifica non riuscita (" + String((e as Error)?.message || e) + ")");
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Usare POST" }, 405);

  const daRobot = !!IMPORT_XML_TOKEN && uguali(req.headers.get("x-import-token") || "", IMPORT_XML_TOKEN);
  const daApp = !daRobot && (await _verificaAccesso(req)) === null;
  if (!daRobot && !daApp) return json({ error: "Non autorizzato" }, 401);

  let body: { fonte?: string; modalita?: string; files?: { fileName?: string; xml?: string }[]; soloLog?: { errore: string }; riepilogo?: string[] };
  try { body = await req.json(); } catch { return json({ error: "Body JSON non valido" }, 400); }
  const fonte = (body.fonte || (daRobot ? "robot" : "app-carica")).slice(0, 60);

  if (daRobot) {
    const riepilogo = Array.isArray(body.riepilogo) ? body.riepilogo.map((x) => String(x).slice(0, 1000)).slice(0, 50) : undefined;
    if (body.soloLog) {
      await supabase.from("integrazioni_freeinvoice_log").insert({ esito: { fonte, errore: String(body.soloLog.errore).slice(0, 2000), riepilogo } });
      return json({ ok: true });
    }
    if (riepilogo && !Array.isArray(body.files)) {
      await supabase.from("integrazioni_freeinvoice_log").insert({ esito: { fonte, riepilogo } });
      return json({ ok: true });
    }
  }

  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length > MAX_FILES) return json({ error: `Massimo ${MAX_FILES} file per chiamata` }, 400);
  const cat = await catalogo();

  // ANTEPRIMA (scheda Carica): legge e controlla, non scrive nulla
  if (body.modalita === "anteprima") {
    const fatture: Record<string, unknown>[] = [];
    for (const file of files) {
      const fileName = (file.fileName || "senza-nome.xml").slice(0, 255);
      try {
        if (!file.xml) throw new Error("contenuto XML vuoto");
        for (const f of leggiFatture(file.xml, fileName, DOMParser)) {
          if (f.direzione !== "vendita") {
            fatture.push({ file_name: fileName, _status: "errore", _error: f.direzione === "acquisto" ? "e' una fattura di acquisto: la carica il robot" : "non emessa da Madame Pivot" });
            continue;
          }
          const { testata, righe } = datiVendita(f, cat);
          const esistente = await trovaVendita(f);
          fatture.push({ ...testata, righe, _sdi: f._sdi, numeroRaw: f.numeroRaw, _status: esistente ? "duplicato" : "pronto" });
        }
      } catch (err) {
        fatture.push({ file_name: fileName, _status: "errore", _error: err instanceof Error ? err.message : String(err) });
      }
    }
    return json({ ok: true, fatture });
  }

  // SALVA (robot e scheda Carica)
  let salvate = 0, saltate = 0, completate = 0, errori = 0;
  const dettaglioErrori: { file: string; motivo: string }[] = [];
  const nuove: { file: string; direzione: string; numero: string | null; data: string | null }[] = [];
  for (const file of files) {
    const fileName = (file.fileName || "senza-nome.xml").slice(0, 255);
    try {
      if (!file.xml) throw new Error("contenuto XML vuoto");
      for (const f of leggiFatture(file.xml, fileName, DOMParser)) {
        let r: { esito: string; motivo?: string };
        if (f.direzione === "vendita") r = await salvaVendita(f, cat);
        else if (f.direzione === "acquisto") {
          if (!daRobot) { r = { esito: "errore", motivo: "fattura di acquisto: la carica il robot" }; }
          else r = await salvaAcquisto(f);
        } else r = { esito: "errore", motivo: "fattura non emessa ne' ricevuta da Madame Pivot" };
        if (r.esito === "ok") { salvate++; nuove.push({ file: fileName, direzione: f.direzione, numero: f.numero, data: f.data }); }
        else if (r.esito === "saltata") saltate++;
        else if (r.esito === "completata") completate++;
        else { errori++; dettaglioErrori.push({ file: fileName, motivo: r.motivo || "errore" }); }
      }
    } catch (err) {
      errori++;
      dettaglioErrori.push({ file: fileName, motivo: err instanceof Error ? err.message : String(err) });
    }
  }
  const esito = { fonte, ricevuti: files.length, salvate, completate, saltate, errori, nuove, dettaglioErrori };
  await supabase.from("integrazioni_freeinvoice_log").insert({ esito });
  return json({ ok: errori === 0, ...esito });
});
