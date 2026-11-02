/**
 * planilla-gestion.mjs - Columnas VIGILAR / CADUCIDAD / ULT. IMPULSO de la planilla
 * LISTADO JUICIOS (nov-2026).
 *
 * Reglas acordadas con la usuaria:
 *  - La planilla manda: lo que diga cada celda se copia a las carteras del bot.
 *  - El bot SUGIERE con "?" (texto gris): "EN ESPERA?", "NO?", "15/10/2026?".
 *    Una sugerencia NO se aplica hasta que la usuaria le saca el "?".
 *  - Si ya habia un valor confirmado y el bot sugiere otro, lo escribe como
 *    "NUEVO? (antes VIEJO)" y sigue usando VIEJO hasta la confirmacion.
 *  - Lo que AUMENTA la vigilancia (p. ej. salio la resolucion de una causa EN ESPERA)
 *    se aplica directo, porque equivocarse para ese lado no tiene riesgo.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim();

/** "EN ESPERA? (antes NO)" -> { vigente: "NO", sugerido: "EN ESPERA" }; "NO" -> { vigente: "NO" } */
export function leerCelda(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { vigente: "", sugerido: "" };
  const m = s.match(/^(.*?)\?\s*(?:\(antes\s*(.*?)\))?\s*$/i);
  if (m) return { vigente: (m[2] || "").trim(), sugerido: m[1].trim() };
  return { vigente: s, sugerido: "" };
}

/** Interpreta las 3 columnas de una fila de la planilla -> overrides vigentes. */
export function gestionDeFila(f) {
  const vig = leerCelda(f.vigilar), cad = leerCelda(f.caducidad), imp = leerCelda(f.ultImpulso);
  const vigilar = /^(no|0|false)$/i.test(vig.vigente) ? "NO" : "";
  const nc = norm(cad.vigente);
  const caducidad = /espera|pendiente|resol/.test(nc) ? "EN ESPERA" : (/^(no|0|false)$/.test(nc) ? "NO" : (/^(si|1|true)$/.test(nc) ? "SI" : ""));
  const fecha = parseFecha(imp.vigente);
  return { vigilar, caducidad, ultImpulso: fecha, crudo: { vig, cad, imp } };
}

export function parseFecha(s) {
  const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  const a = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = new Date(a, Number(m[2]) - 1, Number(m[1]));
  return isNaN(d) ? null : d;
}
export const fmtFecha = (d) => d ? `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}` : "";

// ── vinculos causa del bot <-> fila de la planilla (los guarda el cruce de cada corrida) ──
const vincPath = () => process.env.PLANILLA_VINCULOS_JSON || fileURLToPath(new URL("../planilla-vinculos.json", import.meta.url));
export function leerVinculos() { try { return JSON.parse(fs.readFileSync(vincPath(), "utf8")); } catch { return {}; } }
export function guardarVinculos(sistema, mapa) {
  const v = leerVinculos(); v[sistema] = mapa;
  try { fs.writeFileSync(vincPath(), JSON.stringify(v, null, 1)); } catch {}
}

// ── migracion inicial (una vez por sistema) ────────────────────────────────────
const migPath = () => fileURLToPath(new URL("../planilla-migrada.json", import.meta.url));
export function migradaSistema(sis) { try { return !!JSON.parse(fs.readFileSync(migPath(), "utf8"))[sis]; } catch { return false; } }
export function marcarMigrada(sis) {
  let m = {}; try { m = JSON.parse(fs.readFileSync(migPath(), "utf8")); } catch {}
  m[sis] = new Date().toISOString();
  try { fs.writeFileSync(migPath(), JSON.stringify(m)); } catch {}
}
/** Escribe la migracion pendiente de un sistema y la marca hecha si salio bien. */
export async function completarMigracion(sis, migrar, log = () => {}) {
  if (migradaSistema(sis) || !escrituraConfigurada()) return;
  const r = await escribirCambios(migrar || []);
  if (r.errores && r.errores.length) { log(`Planilla (${sis}): migracion con errores, se reintenta la proxima corrida: ${r.errores.join(" | ")}`); return; }
  marcarMigrada(sis);
  log(`Planilla (${sis}): migracion hecha (${r.hechos} celda(s) pasadas de la cartera a la planilla). Desde ahora la planilla manda.`);
}

// ── escritura en la planilla via Apps Script ──────────────────────────────────
export function escrituraConfigurada() { return !!(process.env.PLANILLA_WEBAPP_URL && process.env.PLANILLA_TOKEN); }

/**
 * cambios: [{hoja, fila, columna: "VIGILAR"|"CADUCIDAD"|"ULT. IMPULSO", valor, tipo: "sugerencia"|"aplicado", nota}]
 * Devuelve { hechos, errores, nota }. No tira: un fallo de la planilla no corta el parte.
 */
export async function escribirCambios(cambios) {
  if (!cambios || !cambios.length) return { hechos: 0, errores: [] };
  if (!escrituraConfigurada()) return { hechos: 0, errores: [], nota: "escritura en planilla no configurada (PLANILLA_WEBAPP_URL/PLANILLA_TOKEN)" };
  try {
    const r = await fetch(process.env.PLANILLA_WEBAPP_URL, {
      method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, redirect: "follow",
      body: JSON.stringify({ token: process.env.PLANILLA_TOKEN, cambios }), signal: AbortSignal.timeout(60000),
    });
    const j = await r.json();
    if (!j.ok) return { hechos: 0, errores: [j.error || `HTTP ${r.status}`] };
    return { hechos: j.hechos || 0, errores: j.errores || [] };
  } catch (e) { return { hechos: 0, errores: [e.message] }; }
}

/**
 * Arma una sugerencia respetando lo que ya hay en la celda:
 *  - celda vacia            -> "VALOR?"
 *  - confirmado distinto    -> "VALOR? (antes CONFIRMADO)"
 *  - ya sugerido igual o confirmado igual -> null (no hace falta escribir)
 */
export function armarSugerencia(crudoCelda, valor) {
  const { vigente, sugerido } = crudoCelda;
  if (norm(sugerido) === norm(valor) || (!sugerido && norm(vigente) === norm(valor))) return null;
  return vigente ? `${valor}? (antes ${vigente})` : `${valor}?`;
}
