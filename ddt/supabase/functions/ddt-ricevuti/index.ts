// Edge Function: ddt-ricevuti — lettura AI dei DDT ricevuti dai fornitori
//
// Due modi di chiamarla (sempre POST JSON):
//  1. dalla pagina "DDT ricevuti" (utente collegato, header Authorization: Bearer <jwt>)
//       { azione: "leggi", id }            legge con l'AI il file di un DDT gia' caricato e compila i campi
//       { azione: "aggiorna_attesi" }      rilegge le fatture d'acquisto dal 2026 e aggiorna l'elenco dei DDT attesi
//  2. dallo script "Postino DDT" (Google Apps Script in madamepivotdocuments@gmail.com, campo token)
//       { azione: "ricevi", token, gmail_message_id, nome_file, file_base64, mittente, oggetto, ricevuta_il }
//       { azione: "manutenzione", token }  rilegge i DDT rimasti "in_lettura" e aggiorna l'elenco dei DDT attesi
//       { azione: "stato_email", token, ids: [gmail_message_id...] }
//                                          dice quali email hanno tutti i DDT protocollati (per spostare l'etichetta)
//
// Il protocollo NON viene assegnato qui: lo assegna la pagina quando si conferma (funzione protocolla_ddt).
//
// Segreti necessari (Supabase > Edge Functions > Secrets):
//   ANTHROPIC_API_KEY   chiave API Anthropic
//   DDT_POSTINO_TOKEN   parola segreta condivisa con lo script Gmail

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import Anthropic from "npm:@anthropic-ai/sdk";
// @ts-ignore: modulo JS
import { estraiRiferimentiDdt } from "./ddt_parser.js";

const BUCKET = "ddt-ricevuti";
const MODELLO = "claude-opus-5-5";
const MAX_BYTES = 20 * 1024 * 1024;
const AZIENDE = {
  "MADAME PIVOT SRL": { piva: "07096860486" },
  "MP SPAZIO LAB SRL": { piva: "07376920489" },
} as const;

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
let _anthropic: Anthropic | null = null;
function anthropic() {
  if (!Deno.env.get("ANTHROPIC_API_KEY")) throw new Error("manca la chiave ANTHROPIC_API_KEY nei segreti delle Edge Functions");
  return (_anthropic ??= new Anthropic()); // legge ANTHROPIC_API_KEY
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function sha256Hex(data: Uint8Array | string) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function b64ToBytes(b64: string) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function tipoFile(bytes: Uint8Array, nome: string): string | null {
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "application/pdf";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (/\.pdf$/i.test(nome)) return "application/pdf";
  return null;
}
const testo = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

// ---------------------------------------------------------------- lettura AI
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["e_un_ddt", "numero_documenti_nel_file", "destinatario_denominazione", "destinatario_piva",
    "fornitore_denominazione", "fornitore_piva", "numero_ddt", "data_ddt", "causale_trasporto", "destinazione",
    "vettore", "numero_colli", "peso", "aspetto_beni", "riferimento_ordine", "righe", "avvisi"],
  properties: {
    e_un_ddt: { type: "boolean", description: "true se il documento e' un documento di trasporto (DDT/bolla)" },
    numero_documenti_nel_file: { type: "integer", description: "quanti DDT distinti ci sono nel file" },
    destinatario_denominazione: { type: "string", description: "intestatario/cessionario del DDT (chi riceve la merce come cliente), '' se assente" },
    destinatario_piva: { type: "string", description: "partita IVA del destinatario, solo cifre, '' se assente" },
    fornitore_denominazione: { type: "string", description: "mittente/cedente che ha emesso il DDT" },
    fornitore_piva: { type: "string", description: "partita IVA del mittente, solo cifre (senza IT), '' se assente" },
    numero_ddt: { type: "string", description: "numero del DDT esattamente come stampato" },
    data_ddt: { type: "string", description: "data del DDT in formato YYYY-MM-DD, '' se illeggibile" },
    causale_trasporto: { type: "string" },
    destinazione: { type: "string", description: "luogo di destinazione della merce se indicato" },
    vettore: { type: "string", description: "vettore/corriere o 'mittente'/'destinatario'" },
    numero_colli: { type: "string" },
    peso: { type: "string", description: "peso con unita' di misura" },
    aspetto_beni: { type: "string" },
    riferimento_ordine: { type: "string", description: "riferimenti a ordini o altri documenti" },
    righe: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["codice", "descrizione", "quantita", "unita_misura"],
        properties: {
          codice: { type: "string" },
          descrizione: { type: "string" },
          quantita: { type: "string" },
          unita_misura: { type: "string" },
        },
      },
    },
    avvisi: { type: "string", description: "dubbi di lettura (parti illeggibili, piu' DDT nel file, documento non DDT), '' se nessuno" },
  },
} as const;

const ISTRUZIONI = `Leggi questo documento di trasporto (DDT) ricevuto da un fornitore e restituisci i dati richiesti.
Contesto: le aziende che ricevono i DDT sono MADAME PIVOT SRL (P.IVA 07096860486) e MP SPAZIO LAB SRL (P.IVA 07376920489), entrambe calzaturifici; MP Spazio Lab ha sede in Via Bellini 24, Sieci (FI).
- Il destinatario e' l'intestatario del documento (cessionario/cliente), NON il luogo di destinazione della merce: la merce di Madame Pivot viene spesso consegnata nella sede di MP Spazio Lab.
- Il fornitore e' chi emette il DDT (mittente/cedente), di solito in intestazione con logo.
- Riporta il numero DDT esattamente come stampato (con lettere, barre e serie).
- Le date sempre in formato YYYY-MM-DD.
- Le righe: una per articolo, quantita' come stampata. Se le righe sono molte riportale tutte.
- Usa '' per i campi assenti o illeggibili e scrivi i dubbi in "avvisi". Non inventare dati.`;

// deno-lint-ignore no-explicit-any
async function leggiConAi(bytes: Uint8Array, mediaType: string): Promise<any> {
  const data = bytesToB64(bytes);
  const allegato = mediaType === "application/pdf"
    ? { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data } }
    : { type: "image" as const, source: { type: "base64" as const, media_type: mediaType as "image/jpeg", data } };

  const stream = anthropic().beta.messages.stream({
    model: MODELLO,
    max_tokens: 32000,
    betas: ["server-side-fallback-2026-07-01"],
    // se il modello rifiuta la richiesta per i filtri di sicurezza, l'API la ripete su un altro modello
    // deno-lint-ignore no-explicit-any
    fallbacks: "default" as any,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: [allegato, { type: "text", text: ISTRUZIONI }] }],
  // deno-lint-ignore no-explicit-any
  } as any);
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("la lettura automatica ha rifiutato il documento");
  if (msg.stop_reason === "max_tokens") throw new Error("documento troppo lungo per la lettura automatica");
  // deno-lint-ignore no-explicit-any
  const t = msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  return JSON.parse(t);
}

function aziendaDa(piva: string, nome: string): string | null {
  const p = (piva || "").replace(/\D/g, "");
  for (const [az, v] of Object.entries(AZIENDE)) if (p && p.endsWith(v.piva)) return az;
  const n = (nome || "").toUpperCase();
  if (/SPAZIO\s*LAB/.test(n)) return "MP SPAZIO LAB SRL";
  if (/MADAME\s*PIVOT/.test(n)) return "MADAME PIVOT SRL";
  return null;
}

async function leggiDdt(id: string) {
  const { data: d, error } = await sb.from("ddt_ricevuti").select("*").eq("id", id).single();
  if (error || !d) throw new Error("DDT non trovato");
  if (d.stato === "protocollato") return d;
  const { data: blob, error: dlErr } = await sb.storage.from(BUCKET).download(d.file_path);
  if (dlErr || !blob) throw new Error("file non trovato in archivio");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const mt = tipoFile(bytes, d.file_nome || d.file_path);
  if (!mt) {
    await sb.from("ddt_ricevuti").update({ stato: "da_confermare", avviso_lettura: "Formato del file non leggibile automaticamente: compila i dati a mano." }).eq("id", id);
    throw new Error("formato file non supportato (usa PDF, JPG o PNG)");
  }
  let r;
  try {
    r = await leggiConAi(bytes, mt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sb.from("ddt_ricevuti").update({ stato: "da_confermare", avviso_lettura: "Lettura automatica non riuscita (" + msg + "): compila i dati a mano." }).eq("id", id);
    throw err;
  }
  const avvisi: string[] = [];
  if (!r.e_un_ddt) avvisi.push("Il documento non sembra un DDT.");
  if (r.numero_documenti_nel_file > 1) avvisi.push(`Il file contiene ${r.numero_documenti_nel_file} DDT: qui e' registrato solo il primo, carica gli altri separatamente.`);
  const azienda = d.azienda || aziendaDa(r.destinatario_piva, r.destinatario_denominazione);
  if (!azienda) avvisi.push("Destinatario non riconosciuto: scegli l'azienda.");
  if (testo(r.avvisi)) avvisi.push(r.avvisi.trim());
  const data = /^\d{4}-\d{2}-\d{2}$/.test(r.data_ddt || "") ? r.data_ddt : null;

  const agg = {
    stato: "da_confermare",
    azienda,
    fornitore_denominazione: testo(r.fornitore_denominazione),
    fornitore_piva: testo((r.fornitore_piva || "").replace(/^IT/i, "")),
    numero_ddt: testo(r.numero_ddt),
    data_ddt: data,
    causale_trasporto: testo(r.causale_trasporto),
    destinazione: testo(r.destinazione),
    vettore: testo(r.vettore),
    numero_colli: testo(r.numero_colli),
    peso: testo(r.peso),
    aspetto_beni: testo(r.aspetto_beni),
    riferimento_ordine: testo(r.riferimento_ordine),
    righe: Array.isArray(r.righe) ? r.righe : [],
    avviso_lettura: avvisi.join(" ") || null,
    dati_letti: r,
  };
  const { data: out, error: upErr } = await sb.from("ddt_ricevuti").update(agg).eq("id", id).select("*").single();
  if (upErr) throw new Error("salvataggio: " + upErr.message);
  return out;
}


// ---------------------------------------------------------------- DDT attesi (dalle fatture d'acquisto)
const DAL = "2026-01-01";
const TIPI_ESCLUSI = ["TD04", "TD05", "TD08", "TD09", "TD16", "TD17", "TD18", "TD19", "TD28"];
const FILTRO_RIGHE = "descrizione.ilike.%ddt%,descrizione.ilike.%d.d.t%,descrizione.ilike.%bolla%,descrizione.ilike.%trasp%";

async function aggiornaAttesi() {
  // deno-lint-ignore no-explicit-any
  const righe: any[] = [];
  for (let da = 0; ; da += 1000) {
    const { data, error } = await sb.from("righe_fattura")
      .select("descrizione, fattura:fatture!inner(id, numero, data, azienda, tipo_documento, fornitore_denominazione, fornitore_piva)")
      .gte("fattura.data", DAL)
      .or(FILTRO_RIGHE)
      .order("id").range(da, da + 999);
    if (error) throw new Error("lettura fatture: " + error.message);
    righe.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const nuovi = new Map<string, Record<string, unknown>>();
  for (const r of righe) {
    const f = r.fattura;
    if (!f || TIPI_ESCLUSI.includes(f.tipo_documento)) continue;
    for (const x of estraiRiferimentiDdt(r.descrizione, Number(String(f.data).slice(0, 4)))) {
      const chiave = `${f.id}|${x.numero_chiave}|${x.data || ""}`;
      if (nuovi.has(chiave)) continue;
      nuovi.set(chiave, {
        chiave, azienda: f.azienda, fattura_id: f.id, fattura_numero: f.numero, fattura_data: f.data,
        fornitore_denominazione: f.fornitore_denominazione, fornitore_piva: f.fornitore_piva,
        numero_ddt: x.numero, numero_chiave: x.numero_chiave, data_ddt: x.data, ddt_nostro: x.nostro, testo: x.testo,
      });
    }
  }
  const lista = [...nuovi.values()];
  let inseriti = 0;
  for (let i = 0; i < lista.length; i += 500) {
    const { data, error } = await sb.from("ddt_riferimenti_fatture")
      .upsert(lista.slice(i, i + 500), { onConflict: "chiave", ignoreDuplicates: true }).select("id");
    if (error) throw new Error("salvataggio elenco: " + error.message);
    inseriti += data?.length || 0;
  }
  const { data: abbinati } = await sb.rpc("abbina_ddt");
  return { righe_lette: righe.length, riferimenti: lista.length, nuovi: inseriti, abbinati: abbinati ?? 0 };
}

// ---------------------------------------------------------------- autorizzazioni
async function utenteAutorizzato(req: Request) {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return false;
  const { data } = await sb.auth.getUser(jwt);
  if (!data?.user) return false;
  const [{ data: a }, { data: b }] = await Promise.all([
    sb.from("utenti_autorizzati").select("user_id").eq("user_id", data.user.id).maybeSingle(),
    sb.from("utenti_ddt").select("user_id").eq("user_id", data.user.id).maybeSingle(),
  ]);
  return !!(a || b);
}
async function postinoAutorizzato(token: unknown) {
  const atteso = Deno.env.get("DDT_POSTINO_TOKEN");
  if (!atteso || typeof token !== "string" || !token) return false;
  return (await sha256Hex(token)) === (await sha256Hex(atteso));
}

// ---------------------------------------------------------------- endpoint
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ errore: "metodo non consentito" }, 405);
  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return json({ errore: "JSON non valido" }, 400); }
  const azione = body?.azione;

  try {
    if (azione === "leggi") {
      if (!(await utenteAutorizzato(req))) return json({ errore: "non autorizzato" }, 401);
      if (!body.id) return json({ errore: "id mancante" }, 400);
      return json({ ok: true, ddt: await leggiDdt(String(body.id)) });
    }

    if (azione === "aggiorna_attesi") {
      if (!(await utenteAutorizzato(req)) && !(await postinoAutorizzato(body.token))) return json({ errore: "non autorizzato" }, 401);
      return json({ ok: true, ...(await aggiornaAttesi()) });
    }

    if (azione === "ricevi") {
      if (!(await postinoAutorizzato(body.token))) return json({ errore: "non autorizzato" }, 401);
      const msgId = String(body.gmail_message_id || "").trim();
      const nome = String(body.nome_file || "").trim();
      const b64 = String(body.file_base64 || "");
      if (!msgId || !nome || !b64) return json({ errore: "campi mancanti" }, 400);
      const bytes = b64ToBytes(b64);
      if (bytes.length > MAX_BYTES) return json({ errore: "file troppo grande" }, 413);
      const mt = tipoFile(bytes, nome);
      if (!mt) return json({ esito: "ignorato", motivo: "non e' un PDF o un'immagine" });
      const impronta = await sha256Hex(bytes);
      const { data: gia } = await sb.from("ddt_ricevuti").select("id, stato, protocollo").eq("impronta", impronta).neq("stato", "scartato").maybeSingle();
      if (gia) return json({ esito: "gia_presente", ...gia });

      const mese = new Date().toISOString().slice(0, 7);
      const path = `email/${mese}/${Date.now()}_${nome.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const { error: upErr } = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: mt, upsert: false });
      if (upErr) return json({ errore: "upload: " + upErr.message }, 500);
      const { data: riga, error: insErr } = await sb.from("ddt_ricevuti").insert({
        file_path: path, file_nome: nome, file_tipo: mt, impronta, origine: "email",
        email_message_id: msgId,
        email_mittente: body.mittente ? String(body.mittente).slice(0, 300) : null,
        email_oggetto: body.oggetto ? String(body.oggetto).slice(0, 500) : null,
        creato_da: null,
      }).select("id").single();
      if (insErr || !riga) {
        await sb.storage.from(BUCKET).remove([path]);
        if (insErr?.code === "23505") return json({ esito: "gia_presente" });
        return json({ errore: "inserimento: " + (insErr?.message || "") }, 500);
      }
      try {
        const d = await leggiDdt(riga.id);
        return json({ esito: "letto", id: riga.id, fornitore: d.fornitore_denominazione, numero: d.numero_ddt });
      } catch (err) {
        return json({ esito: "da_completare", id: riga.id, motivo: err instanceof Error ? err.message : String(err) });
      }
    }

    if (azione === "manutenzione") {
      if (!(await postinoAutorizzato(body.token))) return json({ errore: "non autorizzato" }, 401);
      const prima = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { data: ferme } = await sb.from("ddt_ricevuti").select("id").eq("stato", "in_lettura").lt("creato_il", prima).limit(10);
      let lette = 0;
      for (const f of ferme || []) { try { await leggiDdt(f.id); lette++; } catch { /* resta da completare a mano */ } }
      const { count } = await sb.from("ddt_ricevuti").select("id", { count: "exact", head: true }).eq("stato", "da_confermare");
      const attesi = await aggiornaAttesi();
      return json({ ok: true, rilette: lette, da_confermare: count ?? 0, attesi });
    }

    if (azione === "stato_email") {
      if (!(await postinoAutorizzato(body.token))) return json({ errore: "non autorizzato" }, 401);
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).slice(0, 500);
      if (!ids.length) return json({ ok: true, protocollate: [] });
      const { data, error } = await sb.from("ddt_ricevuti").select("email_message_id, stato, protocollo").in("email_message_id", ids);
      if (error) return json({ errore: error.message }, 500);
      const perEmail = new Map<string, { aperti: number; protocolli: string[] }>();
      for (const r of data || []) {
        const e = perEmail.get(r.email_message_id) || { aperti: 0, protocolli: [] };
        if (r.stato === "protocollato") e.protocolli.push(r.protocollo);
        else if (r.stato !== "scartato") e.aperti++;
        perEmail.set(r.email_message_id, e);
      }
      const protocollate = [...perEmail.entries()].filter(([, e]) => e.aperti === 0).map(([id, e]) => ({ id, protocolli: e.protocolli }));
      return json({ ok: true, protocollate });
    }

    return json({ errore: "azione sconosciuta" }, 400);
  } catch (err) {
    return json({ errore: err instanceof Error ? err.message : String(err) }, 500);
  }
});
