import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Edge Function "lancia-robot": fa partire dal programma i robot che girano su GitHub Actions
// (repository MadamePivot/robot-fatture), senza dover aprire GitHub.
//
// Azioni (campo "azione" del corpo JSON):
//  - lancia  { robot: "sdi", modalita: "prova" | "invia" }
//            { robot: "freeinvoice", giorni?: 1..60 }          (modalita' "scarica" del robot notturno)
//            -> POST /repos/{repo}/actions/workflows/{file}/dispatches
//  - stato   ultime esecuzioni dei due robot (stato, esito, link alla pagina GitHub dell'esecuzione)
//
// Si possono lanciare SOLO questi due workflow e solo con questi valori: il token GitHub non esce mai dalla funzione.
// Secret: GITHUB_ROBOT_TOKEN = token GitHub "fine-grained" limitato al repository robot-fatture con permesso
// "Actions: Read and write" (nient'altro). Facoltativo GITHUB_ROBOT_REPO (default MadamePivot/robot-fatture).

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });

const ROBOT: Record<string, { file: string; nome: string }> = {
  sdi: { file: "gestionale-sera.yml", nome: "Robot SDI" },
  freeinvoice: { file: "fatture-notturne.yml", nome: "Freeinvoice" },
};

// ---- Sicurezza: stesso controllo delle altre funzioni (utenti in utenti_autorizzati o service_role)
async function _verificaAccesso(req: Request): Promise<{ rifiuto: Response | null; email: string | null }> {
  const url = Deno.env.get("SUPABASE_URL")!, srv = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const no = (m: string) => ({ rifiuto: jsonResponse({ ok: false, error: "Non autorizzato: " + m }, 401), email: null });
  const h = { apikey: srv, Authorization: "Bearer " + srv, "Content-Type": "application/json" };
  try {
    const tok = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!tok) return no("manca il login");
    if (tok === srv) return { rifiuto: null, email: "service_role" };
    const u = await fetch(`${url}/auth/v1/user`, { headers: { apikey: srv, Authorization: "Bearer " + tok } });
    if (!u.ok) return no("serve il login di un utente");
    const user = await u.json();
    if (!user?.id) return no("utente non valido");
    const a = await fetch(`${url}/rest/v1/utenti_autorizzati?select=user_id&user_id=eq.${encodeURIComponent(user.id)}`, { headers: h });
    const righe = a.ok ? await a.json() : [];
    return Array.isArray(righe) && righe.length ? { rifiuto: null, email: user.email || user.id } : no("utente non abilitato");
  } catch (e) {
    return no("verifica non riuscita (" + String((e as Error)?.message || e) + ")");
  }
}

async function logChiamata(servizio: string, esito: string, durata: number, dettaglio: string) {
  try {
    const url = Deno.env.get("SUPABASE_URL")!, srv = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    await fetch(`${url}/rest/v1/chiamate_log`, {
      method: "POST",
      headers: { apikey: srv, Authorization: "Bearer " + srv, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ servizio, tipo: "manuale", esito, durata_ms: durata, dettaglio: dettaglio.slice(0, 500) }),
    });
  } catch { /* il log non deve bloccare */ }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  const { rifiuto, email } = await _verificaAccesso(req);
  if (rifiuto) return rifiuto;
  const t0 = Date.now();
  try {
    const token = (Deno.env.get("GITHUB_ROBOT_TOKEN") || "").trim();
    if (!token) return jsonResponse({ ok: false, error: "Manca il secret GITHUB_ROBOT_TOKEN nel progetto Supabase (Edge Functions → Secrets): serve un token GitHub limitato al repository robot-fatture con permesso Actions: Read and write." }, 500);
    const repo = (Deno.env.get("GITHUB_ROBOT_REPO") || "MadamePivot/robot-fatture").trim();
    const gh = (path: string, init: RequestInit = {}) => fetch(`https://api.github.com/repos/${repo}${path}`, {
      ...init,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "gestionale-lancia-robot", ...(init.headers || {}) },
    });
    const body = await req.json().catch(() => ({}));
    const azione = body.azione || "stato";

    if (azione === "stato") {
      const out: Record<string, unknown> = {};
      for (const [chiave, r] of Object.entries(ROBOT)) {
        const res = await gh(`/actions/workflows/${r.file}/runs?per_page=3`);
        const j = await res.json().catch(() => ({}));
        if (!res.ok) { out[chiave] = { errore: `GitHub ${res.status}: ${j.message || ""}` }; continue; }
        out[chiave] = (j.workflow_runs || []).map((x: any) => ({
          id: x.id, stato: x.status, esito: x.conclusion, avviato: x.created_at, aggiornato: x.updated_at,
          evento: x.event, link: x.html_url,
        }));
      }
      return jsonResponse({ ok: true, robot: out });
    }

    if (azione === "lancia") {
      const r = ROBOT[String(body.robot || "")];
      if (!r) return jsonResponse({ ok: false, error: "robot sconosciuto (ammessi: sdi, freeinvoice)" }, 400);
      let inputs: Record<string, string>;
      if (body.robot === "sdi") {
        const modalita = String(body.modalita || "prova");
        if (!["prova", "invia"].includes(modalita)) return jsonResponse({ ok: false, error: "modalita ammesse: prova, invia" }, 400);
        inputs = { modalita };
      } else {
        const giorni = Math.round(Number(body.giorni || 7));
        if (!(giorni >= 1 && giorni <= 60)) return jsonResponse({ ok: false, error: "giorni: da 1 a 60" }, 400);
        inputs = { modalita: "scarica", giorni: String(giorni), giorno_viva: "" };
      }
      const res = await gh(`/actions/workflows/${r.file}/dispatches`, { method: "POST", body: JSON.stringify({ ref: "main", inputs }) });
      if (res.status !== 204) {
        const testo = await res.text();
        await logChiamata(r.nome, "errore", Date.now() - t0, `lancio da programma (${email}) ${JSON.stringify(inputs)}: GitHub ${res.status} ${testo}`);
        return jsonResponse({ ok: false, error: `GitHub ${res.status}: ${testo.slice(0, 300)}` }, 502);
      }
      await logChiamata(r.nome, "ok", Date.now() - t0, `lanciato dal programma (${email}) ${JSON.stringify(inputs)}`);
      return jsonResponse({ ok: true, robot: body.robot, inputs, pagina: `https://github.com/${repo}/actions/workflows/${r.file}` });
    }

    return jsonResponse({ ok: false, error: `azione sconosciuta: ${azione}` }, 400);
  } catch (err) {
    return jsonResponse({ ok: false, error: (err as Error).message || String(err) }, 500);
  }
});
