// nucleo.ts — regole di lettura delle fatture elettroniche (FatturaPA) per Madame Pivot.
// Unico punto in cui sono definite: le usano sia il robot notturno sia la scheda "Carica" dell'app.
// Unisce il parser del robot (fatture di acquisto, scadenze, ritenute, piu' fatture per file,
// XML con prefissi di namespace) e quello dell'app (sezionale, IVA OSS, Natura, modelli scarpe,
// varianti colore, dati per i controlli SDI). Questo file non tocca il database.

// deno-lint-ignore-file no-explicit-any
type El = any;

export const PIVA_MP = "07096860486";

// ---------------- helper XML (indipendenti dai prefissi di namespace) ----------------
function nomeLocale(e: El): string {
  const n = e.localName || e.tagName || e.nodeName || "";
  const i = n.indexOf(":");
  return i >= 0 ? n.slice(i + 1) : n;
}
function tutti(root: El | null): El[] {
  if (!root || !root.getElementsByTagName) return [];
  const list = root.getElementsByTagName("*");
  const out: El[] = [];
  for (let i = 0; i < list.length; i++) out.push(list.item ? list.item(i) : list[i]);
  return out;
}
export function xfind(root: El | null, nome: string): El | null {
  return tutti(root).find((e) => nomeLocale(e) === nome) || null;
}
export function xfindAll(root: El | null, nome: string): El[] {
  return tutti(root).filter((e) => nomeLocale(e) === nome);
}
export function xtext(root: El | null, nome?: string): string | null {
  const el = nome ? xfind(root, nome) : root;
  return el ? (el.textContent || "").trim() : null;
}
function num(v: string | null): number | null {
  return v == null || v === "" ? null : parseFloat(v);
}
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
function ddmmyyyyToIsoOrPass(s: string | null): string | null {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{2})[.\/](\d{2})[.\/](\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s;
}

// codice nazione ISO come nel resto dell'archivio: la Grecia nell'XML arriva come "EL"
export function nazioneIso(n: string | null | undefined): string | null {
  if (!n) return null;
  const c = n.trim().toUpperCase();
  if (!c) return null;
  return c === "EL" ? "GR" : c;
}

// ---------------- catalogo modelli e varianti colore (regole dell'app) ----------------
export interface Catalogo {
  modelli: { parole: string[]; nome_cliente: string; genere: string | null; id_esterno: string | null }[];
  variantiIt: Map<string, string>;
  variantiEn: Map<string, string>;
  perModello: Map<string, { tokens: string[]; canonico: string }[]>;
}
export function normalizzaTesto(s: string | null): string {
  return s ? s.trim().toLowerCase().replace(/\s+/g, " ") : "";
}
export function costruisciCatalogo(modelliRows: any[], variantiRows: any[]): Catalogo {
  const modelli = (modelliRows || [])
    .filter((m) => m.nome_interno)
    .map((m) => ({ parole: String(m.nome_interno).trim().toUpperCase().split(/\s+/), nome_cliente: m.nome_cliente, genere: m.genere, id_esterno: m.id_esterno }))
    .sort((a, b) => b.parole.length - a.parole.length);
  const variantiIt = new Map<string, string>(), variantiEn = new Map<string, string>();
  const perModello = new Map<string, { tokens: string[]; canonico: string }[]>();
  (variantiRows || []).forEach((r) => {
    if (!r.descrizione_it) return;
    const lista = perModello.get(r.id_modello_base_esterno) || [];
    if (r.descrizione_it_norm) {
      variantiIt.set(r.id_modello_base_esterno + "|" + r.descrizione_it_norm, r.descrizione_it);
      lista.push({ tokens: r.descrizione_it_norm.split(" "), canonico: r.descrizione_it });
    }
    if (r.descrizione_en_norm) {
      variantiEn.set(r.id_modello_base_esterno + "|" + r.descrizione_en_norm, r.descrizione_it);
      lista.push({ tokens: r.descrizione_en_norm.split(" "), canonico: r.descrizione_it });
    }
    perModello.set(r.id_modello_base_esterno, lista);
  });
  return { modelli, variantiIt, variantiEn, perModello };
}
function matchFuzzyVarianteColore(cat: Catalogo, resto: string[], idEsterno: string | null) {
  const candidati = idEsterno ? cat.perModello.get(idEsterno) : null;
  if (!candidati || !resto.length) return null;
  const primo = resto[0], ultimo = resto[resto.length - 1];
  let migliore: string | null = null, delta = Infinity;
  for (const c of candidati) {
    if (!c.tokens.length) continue;
    if (c.tokens[0] === primo && c.tokens[c.tokens.length - 1] === ultimo) {
      const d = Math.abs(c.tokens.length - resto.length);
      if (d < delta) { migliore = c.canonico; delta = d; }
    }
  }
  return migliore;
}
function matchModello(cat: Catalogo, tokens: string[]) {
  for (const e of cat.modelli) {
    if (tokens.length < e.parole.length) continue;
    let ok = true;
    for (let i = 0; i < e.parole.length; i++) if (tokens[i].toUpperCase() !== e.parole[i]) { ok = false; break; }
    if (ok) return { nome_cliente: e.nome_cliente, lunghezza: e.parole.length, genere: e.genere, id_esterno: e.id_esterno };
  }
  return null;
}
function separaModelloIncollato(cat: Catalogo, tokens: string[]): string[] {
  for (const e of cat.modelli) {
    const n = e.parole.length;
    if (tokens.length < n) continue;
    let ok = true;
    for (let i = 0; i < n - 1; i++) if (tokens[i].toUpperCase() !== e.parole[i]) { ok = false; break; }
    if (!ok) continue;
    const ultima = e.parole[n - 1], originale = tokens[n - 1], up = originale.toUpperCase();
    if (up.length > ultima.length && up.startsWith(ultima) && /^[A-Z]/.test(originale[ultima.length])) {
      return [...tokens.slice(0, n - 1), originale.slice(0, ultima.length), originale.slice(ultima.length), ...tokens.slice(n)];
    }
  }
  return tokens;
}
export function analizzaDescrizioneModello(cat: Catalogo, desc: string | null) {
  const vuoto = { variante: null as string | null, modelloBase: null as string | null, genere: null as string | null };
  if (!desc) return vuoto;
  let tokens = desc.trim().split(/\s+/);
  if (!tokens.length) return vuoto;
  tokens = separaModelloIncollato(cat, tokens);
  const idxS = tokens.findIndex((t) => /^[SM]\.\d+$/i.test(t));
  const idxH = tokens.findIndex((t) => /^[HT]\.\d+$/i.test(t));
  let cut: number;
  if (idxS >= 0 || idxH >= 0) cut = Math.min(...[idxS, idxH].filter((i) => i >= 0));
  else {
    const sizeIdx = tokens.findIndex((t) => /^\d{2}$/.test(t) && +t >= 28 && +t <= 50);
    cut = sizeIdx >= 0 ? sizeIdx : tokens.length;
  }
  const descTokens = tokens.slice(0, cut);
  if (!descTokens.length) return vuoto;
  const m = matchModello(cat, descTokens);
  if (!m) return vuoto;
  const restoOrig = descTokens.slice(m.lunghezza).join(" ");
  const restoNorm = normalizzaTesto(restoOrig);
  const chiave = m.id_esterno + "|" + restoNorm;
  const restoCanonico = cat.variantiIt.get(chiave) || cat.variantiEn.get(chiave) ||
    matchFuzzyVarianteColore(cat, restoNorm.split(" "), m.id_esterno) || restoOrig;
  return { variante: [m.nome_cliente, restoCanonico].filter(Boolean).join(" "), modelloBase: m.nome_cliente, genere: m.genere };
}
export function parseDescrizioneScarpa(cat: Catalogo, desc: string | null) {
  const vuoto = { modello: null as string | null, taglia: null as string | null, altezza_tacco: null as string | null, calzata: null as string | null };
  if (!desc) return vuoto;
  const tokens = desc.trim().split(/\s+/);
  const idxS = tokens.findIndex((t) => /^[SM]\.\d+$/i.test(t));
  const idxH = tokens.findIndex((t) => /^[HT]\.\d+$/i.test(t));
  if (idxS >= 0 || idxH >= 0) {
    const last = tokens[tokens.length - 1];
    return {
      modello: matchModello(cat, tokens)?.nome_cliente || tokens[0],
      taglia: idxS >= 0 ? tokens[idxS].split(".")[1] : null,
      altezza_tacco: idxH >= 0 ? tokens[idxH].split(".")[1] : null,
      calzata: last.replace(/^F\./i, ""),
    };
  }
  const sizeIdx = tokens.findIndex((t) => /^\d{2}$/.test(t) && +t >= 28 && +t <= 50);
  if (sizeIdx >= 0) {
    return {
      modello: matchModello(cat, tokens)?.nome_cliente || tokens[0],
      taglia: tokens[sizeIdx],
      altezza_tacco: tokens[sizeIdx + 1] && /^\d{2,3}$/.test(tokens[sizeIdx + 1]) ? tokens[sizeIdx + 1] : null,
      calzata: tokens[tokens.length - 1] || null,
    };
  }
  return vuoto;
}

// ---------------- chiave anagrafica cliente (regola dell'app) ----------------
// "XXXXXXX" e' il segnaposto dei privati esteri senza vera P.IVA: non identifica nessuno.
export function chiaveCliente(piva: string | null, cf: string | null): string | null {
  let p = (piva || "").trim(), c = (cf || "").trim();
  if (/^x+$/i.test(p) || /^0+$/.test(p)) p = "";
  if (/^x+$/i.test(c) || /^0+$/.test(c)) c = "";
  return p || c || null;
}

// ---------------- lettura FatturaPA ----------------
export interface Anagrafica {
  idPaese: string | null; idCodice: string | null; idCodicePiva: string | null; cf: string | null;
  denom: string | null; regimeFiscale: string | null; indirizzo: string | null; cap: string | null;
  comune: string | null; provincia: string | null; nazione: string | null;
  codiceDestinatario?: string | null; pec?: string | null;
}

function anagrafica(party: El | null): Anagrafica {
  const da = xfind(party, "DatiAnagrafici");
  const idf = xfind(da, "IdFiscaleIVA");
  const idPaese = xtext(idf, "IdPaese");
  const idCodice = xtext(idf, "IdCodice");
  const cf = xtext(da, "CodiceFiscale");
  const anag = xfind(da, "Anagrafica");
  let denom = xtext(anag, "Denominazione");
  if (!denom) denom = [xtext(anag, "Nome"), xtext(anag, "Cognome")].filter(Boolean).join(" ") || null;
  const idCodicePiva = idCodice && idPaese && !idCodice.toUpperCase().startsWith(idPaese.toUpperCase()) ? idPaese + idCodice : idCodice;
  const sede = xfind(party, "Sede");
  return {
    idPaese, idCodice, idCodicePiva, cf, denom, regimeFiscale: xtext(da, "RegimeFiscale"),
    indirizzo: [xtext(sede, "Indirizzo"), xtext(sede, "NumeroCivico")].filter(Boolean).join(", ") || null,
    cap: xtext(sede, "CAP"), comune: xtext(sede, "Comune"), provincia: xtext(sede, "Provincia"), nazione: xtext(sede, "Nazione"),
  };
}

export function leggiFatture(xmlText: string, fileName: string, DOMParserCtor: any) {
  const errori: string[] = [];
  const doc = new DOMParserCtor({
    errorHandler: { warning: () => {}, error: (m: string) => errori.push(m), fatalError: (m: string) => errori.push(m) },
  }).parseFromString(String(xmlText).replace(/^﻿/, ""), "text/xml");
  if (!doc || !doc.documentElement) throw new Error("XML non valido" + (errori.length ? ": " + errori[0] : ""));
  const header = xfind(doc, "FatturaElettronicaHeader");
  if (!header) throw new Error("Non e' una fattura elettronica (manca FatturaElettronicaHeader)");
  const cedEl = xfind(header, "CedentePrestatore");
  const cesEl = xfind(header, "CessionarioCommittente");
  const ced = anagrafica(cedEl);
  const ces = anagrafica(cesEl);
  const trasm = xfind(header, "DatiTrasmissione");
  const codDest = xtext(trasm, "CodiceDestinatario");
  const pec = xtext(trasm, "PECDestinatario");

  let direzione: "acquisto" | "vendita" | "sconosciuta" = "sconosciuta";
  if (ces.idPaese === "IT" && ces.idCodice === PIVA_MP) direzione = "acquisto";
  else if (ced.idPaese === "IT" && ced.idCodice === PIVA_MP) direzione = "vendita";

  return xfindAll(doc, "FatturaElettronicaBody").map((body) => {
    const dg = xfind(body, "DatiGeneraliDocumento");
    const numeroRaw = xtext(dg, "Numero");
    const data = ddmmyyyyToIsoOrPass(xtext(dg, "Data"));
    const tipoDocumento = xtext(dg, "TipoDocumento");
    const divisa = xtext(dg, "Divisa") || "EUR";

    // vendite: "3/1205" = sezionale 3, numero 1205; senza "/" il sezionale e' 1 (regola dell'app).
    // acquisti: il numero del fornitore resta com'e' (puo' contenere "/").
    let sezionale: string | null = null, numero = numeroRaw;
    if (direzione === "vendita") {
      sezionale = "1";
      if (numeroRaw && numeroRaw.includes("/")) {
        const parti = numeroRaw.split("/");
        sezionale = parti[0].trim();
        numero = parti.slice(1).join("/").trim();
      }
    }

    // Natura dal riepilogo IVA, per le righe che non la riportano
    const dbs = xfind(body, "DatiBeniServizi");
    const riepiloghi = xfindAll(dbs, "DatiRiepilogo");
    let imponibile = 0, impostaRiepilogo = 0;
    const naturaPerAliquota: Record<string, string> = {};
    for (const rp of riepiloghi) {
      imponibile += parseFloat(xtext(rp, "ImponibileImporto") || "0");
      impostaRiepilogo += parseFloat(xtext(rp, "Imposta") || "0");
      const a = xtext(rp, "AliquotaIVA"), n = xtext(rp, "Natura");
      if (a != null && n) naturaPerAliquota[a] = n;
    }
    imponibile = r2(imponibile);
    // OSS: il riepilogo riporta imposta 0, il totale documento invece e' quello vero (regola dell'app)
    const totDich = xtext(dg, "ImportoTotaleDocumento");
    const importoTotale = totDich != null && totDich !== "" ? r2(parseFloat(totDich)) : r2(imponibile + impostaRiepilogo);
    const imposta = r2(importoTotale - imponibile);

    const righeEl = xfindAll(dbs, "DettaglioLinee");
    const righe = righeEl.map((r) => {
      const aliquota_iva = xtext(r, "AliquotaIVA");
      let aliquota_oss: number | null = null, importo_oss: number | null = null;
      for (const t of xfindAll(r, "RiferimentoTesto")) {
        const m = (t.textContent || "").match(/IVA OSS ([\d.,]+)\s*%\s*-\s*Euro\s*([\d.,]+)/i);
        if (m) { aliquota_oss = parseFloat(m[1].replace(",", ".")); importo_oss = parseFloat(m[2].replace(",", ".")); break; }
      }
      return {
        numero_linea: xtext(r, "NumeroLinea"),
        descrizione: xtext(r, "Descrizione"),
        quantita: xtext(r, "Quantita"),
        unita_misura: xtext(r, "UnitaMisura"),
        prezzo_unitario: xtext(r, "PrezzoUnitario"),
        aliquota_iva,
        natura: xtext(r, "Natura") || (aliquota_iva != null ? naturaPerAliquota[aliquota_iva] : null) || null,
        aliquota_oss, importo_oss,
        prezzo_totale: parseFloat(xtext(r, "PrezzoTotale") || "0"),
        codice_articolo: xtext(xfind(r, "CodiceArticolo"), "CodiceValore"),
        riferimento_amministrazione: xtext(r, "RiferimentoAmministrazione"),
      };
    });

    const ritenute = xfindAll(dg, "DatiRitenuta");
    const ritenutaImporto = ritenute.reduce((s, r) => s + parseFloat(xtext(r, "ImportoRitenuta") || "0"), 0);
    const ritenutaCausale = ritenute.map((r) => xtext(r, "CausalePagamento")).filter(Boolean).join(", ");

    const pagamenti = xfindAll(body, "DettaglioPagamento");
    const scadenze = pagamenti.map((d) => ddmmyyyyToIsoOrPass(xtext(d, "DataScadenzaPagamento"))).filter((x): x is string => Boolean(x)).sort();
    const mp = pagamenti.map((d) => xtext(d, "ModalitaPagamento")).find(Boolean);
    const metodoPagamentoPrevisto = mp === "MP12" ? "riba" : mp === "MP05" ? "bonifico" : mp === "MP08" ? "carta" : null;

    // DDT citati nel blocco <DatiDDT> (DatiGenerali): usati dal programma DDT ricevuti (01/11/2026)
    const datiDDT = xfindAll(body, "DatiDDT").map((d) => ({
      numero: xtext(d, "NumeroDDT"),
      data: ddmmyyyyToIsoOrPass(xtext(d, "DataDDT")),
      linee: xfindAll(d, "RiferimentoNumeroLinea").map((x) => (x.textContent || "").trim()).filter(Boolean).join(","),
    })).filter((d) => d.numero);

    // dati usati solo dai controlli SDI dell'anteprima nell'app (non salvati)
    const cesSede = xfind(cesEl, "Sede");
    const bollo = xfind(dg, "DatiBollo");
    const _sdi = {
      formato: xtext(trasm, "FormatoTrasmissione"), codDest, pec, progressivoInvio: xtext(trasm, "ProgressivoInvio"),
      cedPaese: ced.idPaese, cedPiva: ced.idCodice, cedCF: ced.cf, regime: ced.regimeFiscale,
      cessPaese: ces.idPaese, cessIndirizzo: xtext(cesSede, "Indirizzo"), cessCap: xtext(cesSede, "CAP"), cessProvincia: xtext(cesSede, "Provincia"),
      bollo: bollo ? { importo: num(xtext(bollo, "ImportoBollo")), virtuale: xtext(bollo, "BolloVirtuale") } : null,
      condPag: xtext(body, "CondizioniPagamento"),
      pagamenti: pagamenti.map((d) => ({ modalita: xtext(d, "ModalitaPagamento"), scadenza: xtext(d, "DataScadenzaPagamento"), importo: num(xtext(d, "ImportoPagamento")) })),
      riepiloghi: riepiloghi.map((rp) => ({
        aliquota: num(xtext(rp, "AliquotaIVA")), natura: xtext(rp, "Natura"),
        imponibile: num(xtext(rp, "ImponibileImporto")) || 0, imposta: num(xtext(rp, "Imposta")) || 0,
        esigibilita: xtext(rp, "EsigibilitaIVA"), rifNorm: xtext(rp, "RiferimentoNormativo"),
        arrotondamento: num(xtext(rp, "Arrotondamento")), speseAccessorie: num(xtext(rp, "SpeseAccessorie")),
      })),
      righeExtra: righeEl.map((r) => ({ sconto: !!xfind(r, "ScontoMaggiorazione"), tipoCessione: xtext(r, "TipoCessionePrestazione"), ritenuta: xtext(r, "Ritenuta") })),
      descrizioniTesto: [ces.denom, xtext(cesSede, "Indirizzo"), ces.comune],
    };

    return {
      direzione, fileName, numeroRaw, numero, sezionale, data, tipoDocumento, divisa,
      imponibile, imposta, importoTotale, righe,
      ritenutaImporto: ritenutaImporto || null, ritenutaCausale: ritenutaCausale || null,
      dataScadenza: scadenze.length ? scadenze[0] : null, metodoPagamentoPrevisto, datiDDT,
      fornitore: ced, cliente: { ...ces, codiceDestinatario: codDest, pec } as Anagrafica, _sdi,
    };
  });
}
export type Fattura = ReturnType<typeof leggiFatture>[number];

// Campi di testata e righe di una fattura di VENDITA, come li salvava la scheda "Carica"
// (P.IVA cliente senza prefisso paese, nazione ISO), piu' i dettagli scarpe dal catalogo.
export function datiVendita(f: Fattura, cat: Catalogo) {
  const testata = {
    numero: f.numero, sezionale: f.sezionale, data: f.data, tipo_documento: f.tipoDocumento, divisa: f.divisa,
    imponibile: f.imponibile, imposta: f.imposta, importo_totale: f.importoTotale,
    cliente_denominazione: f.cliente.denom, cliente_piva: f.cliente.idCodice, cliente_cf: f.cliente.cf,
    cliente_comune: f.cliente.comune, cliente_nazione: nazioneIso(f.cliente.nazione || f.cliente.idPaese),
    file_name: f.fileName,
  };
  const righe = f.righe.map((r) => {
    const s = parseDescrizioneScarpa(cat, r.descrizione);
    const a = analizzaDescrizioneModello(cat, r.descrizione);
    return {
      numero_linea: r.numero_linea, descrizione: r.descrizione, quantita: r.quantita, unita_misura: r.unita_misura,
      prezzo_unitario: r.prezzo_unitario, aliquota_iva: r.aliquota_iva, natura: r.natura,
      aliquota_oss: r.aliquota_oss, importo_oss: r.importo_oss, prezzo_totale: r.prezzo_totale,
      codice_articolo: r.codice_articolo, riferimento_amministrazione: r.riferimento_amministrazione,
      // conto: quello indicato in fattura; le righe a zero (descrittive) vanno sul conto 10000 (regola del robot)
      codice_conto: r.riferimento_amministrazione || (Number(r.prezzo_totale) === 0 ? "10000" : null),
      modello: s.modello, taglia: s.taglia, altezza_tacco: s.altezza_tacco, calzata: s.calzata,
      modello_base_report: a.modelloBase, variante_report: a.variante, genere_report: a.genere,
    };
  });
  return { testata, righe };
}
