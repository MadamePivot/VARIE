// Edge Function: ddt-ricevuti — supporto server del programma "DDT ricevuti"
//
// La lettura dei DDT NON e' fatta qui: la fa gratis il programma nel browser (testo del PDF o OCR),
// imparando per ogni fornitore dove stanno numero e data. Qui restano:
//  1. dalla pagina (utente collegato, header Authorization: Bearer <jwt>)
//       { azione: "aggiorna_attesi" }      rilegge le fatture d'acquisto dal 2026 e aggiorna l'elenco dei DDT attesi
//  2. dallo script "Postino DDT" (Google Apps Script in madamepivotdocuments@gmail.com, campo token)
//       { azione: "ricevi", token, gmail_message_id, nome_file, file_base64, mittente, oggetto, ricevuta_il }
//                                          archivia l'allegato: il programma lo legge alla prossima apertura
//       { azione: "manutenzione", token }  aggiorna l'elenco dei DDT attesi
//       { azione: "stato_email", token, ids: [gmail_message_id...] }
//                                          dice quali email hanno tutti i DDT protocollati (per spostare l'etichetta)
//
// Segreto necessario (Supabase > Edge Functions > Secrets):
//   DDT_POSTINO_TOKEN   parola segreta condivisa con lo script Gmail

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
// @ts-ignore: modulo JS
import { estraiRiferimentiDdt, riferimentoRigaSemplice } from "./ddt_parser.js";

const BUCKET = "ddt-ricevuti";
const MAX_BYTES = 20 * 1024 * 1024;

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

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
function tipoFile(bytes: Uint8Array, nome: string): string | null {
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "application/pdf";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (/\.pdf$/i.test(nome)) return "application/pdf";
  return null;
}

// ---------------------------------------------------------------- DDT attesi (dalle fatture d'acquisto)
const DAL = "2026-01-01";
const TIPI_ESCLUSI = ["TD04", "TD05", "TD08", "TD09", "TD16", "TD17", "TD18", "TD19", "TD28"];
const FILTRO_RIGHE = "descrizione.ilike.%ddt%,descrizione.ilike.%d.d.t%,descrizione.ilike.%bolla%,descrizione.ilike.%trasp%";

async function aggiornaAttesi() {
  // deno-lint-ignore no-explicit-any
  const righe: any[] = [];
  const viste = new Set<string>();
  const SELECT = "id, descrizione, fattura:fatture!inner(id, numero, data, azienda, tipo_documento, fornitore_denominazione, fornitore_piva)";
  // 1) righe con DDT/bolla/trasporto; 2) nelle fatture differite (TD24) anche le righe "numero del data"
  for (const filtro of [FILTRO_RIGHE, "descrizione.ilike.%del%,descrizione.ilike.%dd%,descrizione.ilike.%data%"]) {
    for (let da = 0; ; da += 1000) {
      let q = sb.from("righe_fattura").select(SELECT).gte("fattura.data", DAL).or(filtro);
      if (filtro !== FILTRO_RIGHE) q = q.eq("fattura.tipo_documento", "TD24");
      const { data, error } = await q.order("id").range(da, da + 999);
      if (error) throw new Error("lettura fatture: " + error.message);
      for (const r of data || []) if (!viste.has(r.id)) { viste.add(r.id); righe.push(r); }
      if (!data || data.length < 1000) break;
    }
  }
  const nuovi = new Map<string, Record<string, unknown>>();
  for (const r of righe) {
    const f = r.fattura;
    if (!f || TIPI_ESCLUSI.includes(f.tipo_documento)) continue;
    let trovati = estraiRiferimentiDdt(r.descrizione, Number(String(f.data).slice(0, 4)));
    if (!trovati.length && f.tipo_documento === "TD24") { const x = riferimentoRigaSemplice(r.descrizione); if (x) trovati = [x]; }
    for (const x of trovati) {
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
      return json({ esito: "ricevuto", id: riga.id });
    }

    if (azione === "manutenzione") {
      if (!(await postinoAutorizzato(body.token))) return json({ errore: "non autorizzato" }, 401);
      const { count } = await sb.from("ddt_ricevuti").select("id", { count: "exact", head: true }).in("stato", ["in_lettura", "da_confermare"]);
      const attesi = await aggiornaAttesi();
      return json({ ok: true, da_confermare: count ?? 0, attesi });
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
