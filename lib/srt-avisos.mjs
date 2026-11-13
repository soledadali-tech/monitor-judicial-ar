/**
 * srt-avisos.mjs - Avisos de la pestaña SRT de la planilla LISTADO JUICIOS.
 *
 * Caso: a una persona le dieron el alta medica. Se carga en la pestaña SRT (PERSONA, ART,
 * FECHA ALTA) y el aviso es ALTA + 30 dias corridos, para iniciar el expediente sin perder
 * tiempo. Si la columna INICIADO dice SI, el caso deja de avisar.
 *
 * Estados (mismos que los colores de la planilla):
 *   VENCIDO     la fecha de aviso ya paso y no esta iniciado
 *   POR VENCER  faltan 7 dias o menos (incluye el dia del aviso)
 *
 * La planilla es la fuente de la verdad: aca no se guarda nada, se lee cada vez.
 * Lectura: por el Apps Script (hoja "SRT") si PLANILLA_WEBAPP_URL esta configurada; si
 * no, por CSV con el gid de la pestaña (SRT_GID, por defecto el de la planilla actual).
 * No manda mails: devuelve los bloques para que los incluya el parte diario.
 */
import { parseCsv } from "./planilla-causas.mjs";

export const DIAS_AVISO = 30;      // regla de la abogada; hoy son dias corridos
export const DIAS_PREVIOS = 7;     // desde cuando figura como POR VENCER

const sheetId = () => (process.env.PLANILLA_SHEET_ID || "1d59JfgSQepz-B8WmAfHdWs4Vl10YGcxn3xV9eK8kjok").trim();
const gidSrt = () => (process.env.SRT_GID || "927998137").trim();
const norm = (s) => String(s ?? "").toUpperCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** "15/10/2026", "2026-10-15" o "2026-10-15T00:00:00.000Z" -> "2026-10-15" (o null). */
export function aIso(v) {
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
const sumarDias = (iso, n) => new Date(new Date(iso + "T00:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10);
const diasEntre = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000); // b - a
const fmt = (iso) => iso.split("-").reverse().join("/");

/** valores: matriz de la pestaña (primera fila vacia o encabezados). Devuelve filas como objetos. */
export function filasSrt(valores) {
  const iH = valores.findIndex((f) => f.some((c) => norm(c) === "PERSONA"));
  if (iH < 0) return [];
  const headers = valores[iH].map(norm);
  const col = (nombre) => headers.findIndex((h) => h.startsWith(nombre));
  const iP = col("PERSONA"), iA = col("ART"), iF = col("FECHA ALTA"), iI = col("INICIADO"), iE = col("EXPEDIENTE"), iO = col("ORIGEN");
  return valores.slice(iH + 1).map((f) => ({
    persona: String(f[iP] ?? "").trim(), art: iA >= 0 ? String(f[iA] ?? "").trim() : "",
    alta: aIso(f[iF]), iniciado: norm(f[iI]) === "SI",
    expediente: iE >= 0 ? String(f[iE] ?? "").trim() : "", origen: iO >= 0 ? String(f[iO] ?? "").trim() : "",
  })).filter((r) => r.persona && r.alta);
}

/** Calcula los avisos. hoyISO: "YYYY-MM-DD" (hora argentina). */
export function calcularAvisos(filas, hoyISO) {
  const vencidos = [], porVencer = [];
  for (const r of filas) {
    if (r.iniciado) continue;
    const aviso = sumarDias(r.alta, DIAS_AVISO);
    const dias = diasEntre(hoyISO, aviso); // negativo = ya paso
    const item = { ...r, aviso, dias };
    if (dias < 0) vencidos.push(item);
    else if (dias <= DIAS_PREVIOS) porVencer.push(item);
  }
  vencidos.sort((a, b) => a.aviso.localeCompare(b.aviso));
  porVencer.sort((a, b) => a.aviso.localeCompare(b.aviso));
  return { vencidos, porVencer };
}

async function leerValores() {
  if (process.env.PLANILLA_WEBAPP_URL) {
    const url = `${process.env.PLANILLA_WEBAPP_URL}?token=${encodeURIComponent(process.env.PLANILLA_TOKEN || "")}`;
    const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`webapp HTTP ${r.status}`);
    const j = await r.json();
    if (!j.ok) throw new Error(`webapp: ${j.error || "respuesta invalida"}`);
    const h = (j.hojas || []).find((x) => norm(x.nombre) === "SRT");
    if (!h) throw new Error('la pestaña "SRT" no existe en la planilla');
    return h.valores || [];
  }
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${sheetId()}/export?format=csv&gid=${encodeURIComponent(gidSrt())}`, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} leyendo la pestaña SRT`);
  return parseCsv(await r.text());
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const linea = (c) => `${c.persona}${c.art ? " (" + c.art + ")" : ""} - alta ${fmt(c.alta)}, aviso ${fmt(c.aviso)}${c.dias < 0 ? ` (hace ${-c.dias} dia(s))` : c.dias === 0 ? " (HOY)" : ` (en ${c.dias} dia(s))`}`;

/** Bloques de texto y HTML para el mail. Devuelve null si no hay nada que avisar y la lectura anduvo. */
export function armarBloque({ vencidos, porVencer, error }) {
  if (error) {
    const t = `>>> SRT: no se pudo leer la pestaña SRT (${error}). Los avisos de alta medica de hoy NO se revisaron. <<<\n\n`;
    return { texto: t, html: `<div style="border:2px solid #8b1e1e;border-radius:4px;padding:8px 10px;margin:10px 0;color:#8b1e1e"><b>SRT: no se pudo leer la pestaña SRT</b> (${esc(error)}). Los avisos de alta médica de hoy no se revisaron.</div>` };
  }
  if (!vencidos.length && !porVencer.length) return null;
  const texto = `>>> SRT - INICIAR EXPEDIENTE (alta + ${DIAS_AVISO} dias) <<<\n` +
    (vencidos.length ? `VENCIDOS (${vencidos.length}):\n` + vencidos.map((c) => "  - " + linea(c)).join("\n") + "\n" : "") +
    (porVencer.length ? `POR VENCER (${porVencer.length}):\n` + porVencer.map((c) => "  - " + linea(c)).join("\n") + "\n" : "") +
    `Cuando inicies el expediente, marcalo en la pestaña SRT (INICIADO = SI) y deja de avisar.\n\n`;
  const li = (c, color) => `<li style="color:${color}">${esc(c.persona)}${c.art ? " (" + esc(c.art) + ")" : ""} &mdash; alta ${fmt(c.alta)}, aviso <b>${fmt(c.aviso)}</b> ${c.dias < 0 ? `(hace ${-c.dias} día(s))` : c.dias === 0 ? "<b>(HOY)</b>" : `(en ${c.dias} día(s))`}</li>`;
  const html = `<div style="border:2px solid ${vencidos.length ? "#8b1e1e" : "#b7791f"};border-radius:4px;padding:8px 10px;margin:10px 0"><b>SRT &mdash; iniciar expediente (alta + ${DIAS_AVISO} días)</b>` +
    (vencidos.length ? `<div style="margin-top:6px"><b style="color:#8b1e1e">Vencidos (${vencidos.length})</b><ul style="margin:4px 0">${vencidos.map((c) => li(c, "#8b1e1e")).join("")}</ul></div>` : "") +
    (porVencer.length ? `<div style="margin-top:6px"><b style="color:#b7791f">Por vencer (${porVencer.length})</b><ul style="margin:4px 0">${porVencer.map((c) => li(c, "#7a5200")).join("")}</ul></div>` : "") +
    `<div style="font-size:12px;color:#555">Cuando inicies el expediente, marcalo en la pestaña SRT (INICIADO = SI) y deja de avisar.</div></div>`;
  return { texto, html };
}

/** Lee la pestaña SRT y devuelve { vencidos, porVencer, bloque, asunto }. Nunca tira: si falla, devuelve un aviso de error. */
export async function avisosSrt(hoyISO) {
  try {
    const { vencidos, porVencer } = calcularAvisos(filasSrt(await leerValores()), hoyISO);
    const asunto = vencidos.length ? `[SRT ${vencidos.length} VENCIDO(S)] ` : porVencer.length ? `[SRT ${porVencer.length} POR VENCER] ` : "";
    return { vencidos, porVencer, bloque: armarBloque({ vencidos, porVencer }), asunto };
  } catch (e) {
    return { vencidos: [], porVencer: [], error: e.message, bloque: armarBloque({ error: e.message }), asunto: "[FALLA SRT] " };
  }
}
