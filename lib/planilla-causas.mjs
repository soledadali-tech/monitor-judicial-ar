/**
 * planilla-causas.mjs - Ingesta de la planilla Google Sheets "LISTADO JUICIOS": la
 * fuente autoritativa de la cartera (que causas hay, quien es actor/demandado, la
 * materia y quien firma). El bot la usa para completar y cruzar lo que descubre solo
 * (feed del PJN, barrido de la MEV), NO para reemplazar el scraping de movimientos.
 *
 * La planilla se comparte "cualquiera con el enlace puede ver", asi que se lee via el
 * endpoint publico de exportacion CSV (sin login, sin API key, sin dependencias nuevas).
 * Tiene 5 pestañas: una de PJN (fueros nacionales) y cuatro de MEV/SCBA (deptos de
 * Provincia). Si en el futuro se agrega una pestaña de EJE/CABA, sumarla a PESTANAS.
 *
 * Config .env (opcional; ya trae defaults que funcionan):
 *   PLANILLA_SHEET_ID   ID de la planilla (lo que va despues de /d/ en la URL).
 *   PLANILLA_GIDS       Remapeo de pestañas "nombre:gid,nombre:gid" (ver PESTANAS).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Pestaña -> { gid, sistema }. "sistema" decide como se normaliza cada fila (ver mas
// abajo). Los gid son los reales de la planilla compartida por el usuario.
const PESTANAS_DEFAULT = [
  { nombre: "CABA - CIVIL", gid: "0", sistema: "PJN" },
  { nombre: "LABORAL PROV", gid: "975572488", sistema: "MEV", fueroPestana: "Laboral" },
  { nombre: "CONTENCIOSO", gid: "2068964064", sistema: "MEV", fueroPestana: "Cont. Adm." },
  { nombre: "CIVIL QUILMES", gid: "453027100", sistema: "MEV", fueroPestana: "Civil y Comercial" },
  { nombre: "CIVIL LOMAS", gid: "527621819", sistema: "MEV", fueroPestana: "Civil y Comercial" },
];

// Codigo de DEPTO (columna de la planilla) -> nombre completo del departamento judicial
// tal como lo usa la MEV (POSloguin.asp / MEV_JURISDICCIONES). Completar si aparecen
// otros codigos en la planilla; el fallback es devolver el codigo tal cual.
const DEPTOS = { LZ: "Lomas de Zamora", QL: "Quilmes" };

function sheetId() {
  return (process.env.PLANILLA_SHEET_ID || "1d59JfgSQepz-B8WmAfHdWs4Vl10YGcxn3xV9eK8kjok").trim();
}

function pestanas() {
  const override = (process.env.PLANILLA_GIDS || "").trim();
  if (!override) return PESTANAS_DEFAULT;
  const gidsPorNombre = new Map();
  for (const par of override.split(",")) {
    const [nombre, gid] = par.split(":").map((s) => s.trim());
    if (nombre && gid) gidsPorNombre.set(nombre.toLowerCase(), gid);
  }
  return PESTANAS_DEFAULT.map((p) => {
    const g = gidsPorNombre.get(p.nombre.toLowerCase());
    return g ? { ...p, gid: g } : p;
  });
}

export function cachePath() {
  return process.env.PLANILLA_CACHE_JSON || path.resolve(__dirname, "..", "planilla-causas-cache.json");
}

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim();

// ── parser CSV minimo (RFC 4180 basico: comillas, comas y saltos de linea embebidos) ──
export function parseCsv(texto) {
  const filas = [];
  let fila = [], campo = "", enComillas = false;
  const s = String(texto ?? "").replace(/\r\n/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (enComillas) {
      if (c === '"') {
        if (s[i + 1] === '"') { campo += '"'; i++; } else enComillas = false;
      } else campo += c;
    } else if (c === '"') enComillas = true;
    else if (c === ",") { fila.push(campo); campo = ""; }
    else if (c === "\n") { fila.push(campo); filas.push(fila); fila = []; campo = ""; }
    else campo += c;
  }
  if (campo !== "" || fila.length) { fila.push(campo); filas.push(fila); }
  return filas;
}

function filaAObjeto(headers, fila) {
  const o = {};
  headers.forEach((h, i) => { if (h) o[h] = (fila[i] ?? "").trim(); });
  return o;
}

// Encuentra la fila de encabezados real (la planilla trae filas vacias antes) y
// devuelve las filas de datos como objetos { HEADER: valor }.
function filasComoObjetos(csvFilas) {
  const iHeader = csvFilas.findIndex((f) => f.some((c) => /^(FUERO|TRIBUNAL)$/i.test(String(c).trim())));
  if (iHeader < 0) return [];
  const headers = csvFilas[iHeader].map((h) => String(h).trim().toUpperCase());
  const out = [];
  for (let r = iHeader + 1; r < csvFilas.length; r++) {
    const fila = csvFilas[r];
    if (!fila || !fila.some((c) => String(c).trim())) continue;
    const o = filaAObjeto(headers, fila);
    if (norm(o.FUERO || o.TRIBUNAL) === norm(headers[0])) continue; // encabezado repetido
    out.push(o);
  }
  return out;
}

function normalizarPJN(obj, hoja) {
  const numero = String(obj.NUMERO || "").trim();
  if (!numero) return null;
  return {
    sistema: "PJN",
    fuero: String(obj.FUERO || "").trim().toUpperCase(),
    numero,
    anio: String(obj["AÑO"] || obj.ANIO || obj.AÑO || "").trim(),
    inc: String(obj.INC || "").trim(),
    actor: String(obj.ACTOR || "").trim(),
    demandado: String(obj.DEMANDADO || "").trim(),
    materia: String(obj.MATERIA || "").trim(),
    firma: String(obj.FIRMA || "").trim(),
    hoja,
  };
}

function normalizarMEV(obj, hoja, fueroPestana) {
  const numero = String(obj.NUMERO || "").trim();
  if (!numero) return null;
  const deptoCod = String(obj.DEPTO || "").trim().toUpperCase();
  return {
    sistema: "MEV",
    depto: DEPTOS[deptoCod] || deptoCod || "",
    deptoCod,
    tribunal: String(obj.TRIBUNAL || "").trim(),
    numero,
    fuero: fueroPestana || "",
    actor: String(obj.ACTOR || "").trim(),
    demandado: String(obj.DEMANDADO || "").trim(),
    materia: String(obj.MATERIA || "").trim(),
    firma: String(obj.FIRMA || "").trim(),
    hoja,
  };
}

async function descargarPestana(gid) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId()}/export?format=csv&gid=${encodeURIComponent(gid)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} descargando gid=${gid}`);
  return await r.text();
}

/**
 * Descarga y normaliza las 5 pestañas. Cachea el resultado en disco; si el fetch
 * falla (sin red, sheet sin permisos, etc.) devuelve el cache anterior con
 * stale:true en vez de tirar el proceso.
 */
export async function obtenerPlanilla({ forzar = false } = {}) {
  const filas = [];
  const errores = [];
  for (const pestana of pestanas()) {
    try {
      const csv = await descargarPestana(pestana.gid);
      const objs = filasComoObjetos(parseCsv(csv));
      for (const o of objs) {
        const fila = pestana.sistema === "PJN" ? normalizarPJN(o, pestana.nombre) : normalizarMEV(o, pestana.nombre, pestana.fueroPestana);
        if (fila) filas.push(fila);
      }
    } catch (e) {
      errores.push({ pestana: pestana.nombre, gid: pestana.gid, error: e.message });
    }
  }

  if (filas.length === 0 && errores.length > 0 && !forzar) {
    const cache = leerCache();
    if (cache) return { ...cache, stale: true, error: errores.map((e) => `${e.pestana}: ${e.error}`).join("; ") };
    return { filas: [], porSistema: { PJN: [], MEV: [] }, actualizada: null, stale: true, error: errores.map((e) => `${e.pestana}: ${e.error}`).join("; ") };
  }

  const porSistema = { PJN: filas.filter((f) => f.sistema === "PJN"), MEV: filas.filter((f) => f.sistema === "MEV") };
  // "error" (string, resumen) queda seteado tanto en la caida total (mas arriba) como en
  // una falla parcial (algunas pestañas sí bajaron) para que quien solo mira `.error` no
  // se pierda un aviso — el detalle por pestaña sigue disponible en `errores`.
  const resultado = {
    filas, porSistema, actualizada: new Date().toISOString(), stale: false,
    errores: errores.length ? errores : undefined,
    error: errores.length ? errores.map((e) => `${e.pestana}: ${e.error}`).join("; ") : undefined,
  };
  guardarCache(resultado);
  return resultado;
}

function leerCache() {
  try {
    const p = cachePath();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch { return null; }
}

function guardarCache(data) {
  try { fs.writeFileSync(cachePath(), JSON.stringify(data, null, 2)); } catch { /* no bloquea el flujo */ }
}
