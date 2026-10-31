// Estrae i riferimenti DDT dal testo delle righe fattura.
// Usato dalla funzione ddt-ricevuti (azione aggiorna_attesi).

const KW = /(?:\bd\.?\s?d\.?\s?t\.?|\bdoc(?:umento)?\.?\s*(?:di\s+)?trasp(?:orto)?\.?|\bbolla(?:\s+di\s+consegna)?)/gi;
const DATA = /(?<![\d\/])(?:(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{4}|\d{2}))?)(?![\d\/])/g;

function pad(n){ return String(n).padStart(2,'0'); }

function leggiData(m, annoFattura){
  let y, mo, d;
  if(m[1]){ y=+m[1]; mo=+m[2]; d=+m[3]; }
  else { d=+m[4]; mo=+m[5]; y=m[6]? +m[6] : null; if(y!==null && y<100) y+=2000; }
  if(!y) y=annoFattura;           // "03/03" senza anno: uso l'anno della fattura
  if(!(mo>=1&&mo<=12&&d>=1&&d<=31&&y>=2000&&y<=2100)) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

function pulisciNumero(s){
  let t=s.replace(/\s+/g,' ').trim();
  // parole di contorno tra "DDT" e il numero
  for(let i=0;i<4;i++){
    t=t.replace(/^(?:\/?d\.?d\.?t\.?|[a-z]{2,4}\)|\)|di vendita|vs\.?|vostro|ns\.?|nostro|terz\.?|rif\.?|n\.?\s?[:°º]?|nr\.?|num\.?|numero|nro\.?|no\.?|[:\-–,#.]|\s)+/i,'').trim();
  }
  t=t.replace(/(?:\s|[-–,:]|\bdel\b|\bdd\b|\bdata\b|\bin\s+data\b)+$/i,'').trim();
  return t;
}

export function chiaveNumero(numero){
  // primo gruppo di cifre senza zeri iniziali + eventuali lettere attaccate: "00669"->"669", "BC 113"->"113", "23/C"->"23", "06A"->"6a", "1.331/V"->"1331"
  const m=(numero||'').toLowerCase().replace(/(\d)\.(?=\d)/g,'$1').match(/(\d+)([a-z]?)/);
  return m ? String(parseInt(m[1],10))+m[2] : (numero||'').toLowerCase().replace(/[^a-z0-9]/g,'');
}

export function estraiRiferimentiDdt(testo, annoFattura){
  const out=[]; if(!testo) return out;
  const s=String(testo);
  KW.lastIndex=0; let k;
  while((k=KW.exec(s))){
    const prima=s.slice(Math.max(0,k.index-12),k.index).toLowerCase();
    const dopo=s.slice(k.index+k[0].length, k.index+k[0].length+70);
    // prima data valida dopo la parola chiave (entro 40 caratteri)
    let dm=null, data=null; DATA.lastIndex=0; let m;
    while((m=DATA.exec(dopo))){ if(m.index>40) break; const d=leggiData(m, annoFattura); if(d){ dm=m; data=d; break; } }
    let numero, fine;
    const taglio = dm ? dopo.slice(0,dm.index).search(/[,;]|\bdata\b/i) : -1;
    if(dm && taglio<0){
      numero=pulisciNumero(dopo.slice(0,dm.index));
      fine=dm.index+dm[0].length;
    }else{
      dm=null; data=null;
      // nessuna data: prendo solo il codice subito dopo "DDT n."
      const pul=pulisciNumero(dopo.slice(0,40).split(/[,;]/)[0]);
      const c=pul.match(/^[a-z0-9][a-z0-9\/\-_.]*/i);
      numero=c?c[0].replace(/[.\-]+$/,''):'';
      fine=dopo.indexOf(numero)+numero.length;
    }
    if(!numero || !/\d/.test(numero) || numero.length>40) continue;
    const nostro=/\b(vs|vostro|vostra|vostri)\.?\s*$/i.test(prima) || /^\s*vs\b/i.test(dopo);
    out.push({numero, numero_chiave:chiaveNumero(numero), data, nostro, testo:s.slice(Math.max(0,k.index-15), k.index+k[0].length+fine).trim()});
    KW.lastIndex = k.index+k[0].length+Math.max(fine,0);
  }
  return out;
}

// Fatture differite (TD24): una riga fatta solo di "numero del data" e' il riferimento al DDT,
// anche senza la parola DDT (es. Solettificio Terry "696/   Del:05-08-2026", Punto Fibbia "1088/61 Del:18-05-2026").
const RIGA_SEMPLICE = /^\s*([A-Za-z0-9][A-Za-z0-9\/\-.]{0,15}?)\s*\/?\s*(?:del|dd|data)\s*[:.]?\s*(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\s*$/i;
export function riferimentoRigaSemplice(testo){
  const m=RIGA_SEMPLICE.exec(String(testo||''));
  if(!m || !/\d/.test(m[1])) return null;
  let y=+m[4]; if(y<100) y+=2000;
  const mo=+m[3], d=+m[2];
  if(!(mo>=1&&mo<=12&&d>=1&&d<=31)) return null;
  const numero=m[1].replace(/[\/\-.]+$/,'');
  return { numero, numero_chiave:chiaveNumero(numero), data:`${y}-${pad(mo)}-${pad(d)}`, nostro:false, testo:String(testo).trim() };
}
