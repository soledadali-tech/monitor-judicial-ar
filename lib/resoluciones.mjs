/**
 * resoluciones.mjs - el TEXTO de cada cedula/despacho de PJN (nov-2026).
 * El feed de PJN solo dice "cedula" o "despacho"; lo que importa (traslado, intimacion, sentencia, "tengase presente") esta en el PDF.
 * Aca se extrae la parte dispositiva del PDF, se clasifica (tramite / sensible) y se guarda en data/resoluciones.json (por id de evento)
 * para que el parte, la prioridad y los demas programas usen el contenido real. Todo es orientativo: no reemplaza leer el expediente.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
export const RUTA = process.env.RESOLUCIONES_JSON || path.resolve(__dirname, "..", "data", "resoluciones.json");

export async function textoPdf(buf) {
  const { PDFParse } = await import("pdf-parse");
  const p = new PDFParse({ data: buf });
  try { return String((await p.getText()).text || "").replace(/\s+/g, " ").trim(); } finally { await p.destroy?.(); }
}

// Mero tramite: no abre plazo ni cambia el rumbo. Sensible: puede abrir plazo, resolver o requerir una accion.
const RX_TRAMITE = /\b(t[eé]ngase presente|ag[rg]u[eé]gue(?:se)?|h[aá]gase saber|como se pide|est[eé]se a lo|por presentado|[tT]iénese presente|sirva la presente)/i;
const RX_SENSIBLE = /\b(c[oó]rrase traslado|traslado|intim|apercib|sentencia|vistos:|resuelvo|resuelve|hace lugar|rechaz|conc[eé]dese|recurso|apelaci[oó]n|expresi[oó]n de agravios|audiencia|vista|plazo|d[ií]as|honorarios|regulo|embarg|libra(?:se)? oficio|l[ií]brese|dej[aá]se sin efecto|caduc|peren|suspend|elev[eé]nse)/i;

/** Saca la parte dispositiva de la cedula/despacho: despues de "se ha dictado la siguiente resolucion:" y sin firma. */
export function extraerResolucion(texto) {
  const t = String(texto || "");
  const i = t.search(/se ha dictado la siguiente resoluci[oó]n:/i);
  let res = i >= 0 ? t.slice(i).replace(/^.*?resoluci[oó]n:\s*/i, "") : "";
  if (!res) { // despachos/sentencias sin el encabezado de cedula: se toma desde "VISTOS" o desde la fecha ("Buenos Aires, ..")
    const j = t.search(/\bVISTOS?:|AUTOS Y VISTOS|Buenos Aires,?\s+\d{1,2}\s+de\s+[a-záéíóú]+\s+de\s+\d{4}/i);
    if (j >= 0) res = t.slice(j);
  }
  res = res.replace(/\s*Queda Ud\. legalmente notificado.*$/i, "").replace(/\s*Fdo\.:.*$/i, "")
    .replace(/\s+(?:[A-ZÁÉÍÓÚÑ]{3,}\s+){1,5}(?:JUEZ|JUEZA|SECRETARI[OA]|PROSECRETARI[OA][A-Z ]*|VOCAL)\b.*$/, "").trim();
  const f = res.match(/Buenos Aires,?\s+(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i) || t.match(/emisi[oó]n[^0-9]*(\d{1,2})\s+([a-záéíóú]+)\s+(\d{4})/i);
  const fecha = f && MESES[f[2].toLowerCase()] ? `${f[3]}-${String(MESES[f[2].toLowerCase()]).padStart(2, "0")}-${f[1].padStart(2, "0")}` : "";
  const cuerpo = res.replace(/^.*?Buenos Aires,?\s+\d{1,2}\s+de\s+[a-záéíóú]+\s+de\s+\d{4}\.?\s*/i, "").replace(/\s+/g, " ").trim();
  return { fecha, cuerpo, ...clasificar(cuerpo) };
}

export function clasificar(cuerpo) {
  const sensible = RX_SENSIBLE.test(cuerpo || "");
  return { sensible, tramite: !!cuerpo && !sensible && RX_TRAMITE.test(cuerpo) };
}

export const resumenCorto = (cuerpo, max = 200) => { const s = String(cuerpo || "").replace(/\s+/g, " ").trim(); return s.length > max ? s.slice(0, max - 1) + "…" : s; };

export function leerResoluciones() { try { return JSON.parse(fs.readFileSync(RUTA, "utf8")); } catch { return {}; } }

/** Guarda (o actualiza) una resolucion por id de evento. */
export function registrarResolucion({ id, clave, tipo, fechaAccion, cuenta }, r) {
  const todo = leerResoluciones();
  todo[String(id)] = { id: String(id), clave, tipo, fecha: r.fecha || (fechaAccion ? new Date(fechaAccion).toISOString().slice(0, 10) : ""), cuerpo: r.cuerpo, sensible: r.sensible, tramite: r.tramite, cuenta: cuenta || "", leida: new Date().toISOString() };
  fs.mkdirSync(path.dirname(RUTA), { recursive: true });
  fs.writeFileSync(RUTA, JSON.stringify(todo, null, 1));
}
