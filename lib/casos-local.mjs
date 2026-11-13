/**
 * casos-local.mjs - Almacen propio de las causas del monitor (reemplaza a la tabla
 * public.casos de Supabase). Un solo archivo JSON, sin servicios externos:
 *
 *   data/casos.json   (o CASOS_STORE en .env). Escritura atomica (tmp + rename).
 *
 * Que guarda por causa: datos basicos (actor, demandado, materia, firma, juzgado...),
 * ORIGEN / SOCIO / PORCENTAJE (leidos de la planilla LISTADO JUICIOS, que es la
 * fuente: se sobrescriben siempre), ultimaActuacion y novedades (sin repetir:
 * dedup por fecha+descripcion). Cualquier otro campo que alguien agregue a mano a una
 * causa (detalle, accionRecomendada, fechasClave...) se conserva: este modulo solo
 * completa campos vacios y agrega novedades, nunca pisa lo ya cargado.
 *
 * LA FUENTE DE LA VERDAD ES LA PLANILLA (LISTADO JUICIOS), con o sin Supabase. Este
 * archivo es derivado: si se pierde, se reconstruye desde la planilla y los portales
 * (solo se pierden las novedades ya registradas y lo que se haya agregado a mano).

 * Una causa que el monitor ve pero la planilla NO lista se desestima: no se guarda y se
 * informa en `descartadas` (decision del 13 nov 2026). Y el resultado informa `planillaSinCausa`,
 * las filas de la planilla que todavia no tienen causa detectada.
 *
 * Misma firma que sincronizarCasos() de sync-supabase.mjs: ({ sistema, causas }).
 * El origen se cruza con la planilla por numero y, si no alcanza (en MEV el numero de
 * la planilla no es el del expediente), por actor+demandado. Si el cruce da mas de un
 * candidato y no coinciden entre si, no se asigna y se informa en `sinOrigen`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function rutaStore() {
  const p = (process.env.CASOS_STORE || "").trim();
  return p ? path.resolve(p) : path.join(__dirname, "..", "data", "casos.json");
}

export function leerStore() {
  try {
    const j = JSON.parse(fs.readFileSync(rutaStore(), "utf8"));
    if (j && typeof j.casos === "object") return j;
  } catch { /* primera corrida o archivo ilegible: se arranca vacio */ }
  return { version: 1, actualizado: null, casos: {} };
}

export function guardarStore(store) {
  const ruta = rutaStore();
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  store.actualizado = new Date().toISOString();
  const tmp = `${ruta}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, ruta);
}

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const vacio = (v) => v == null || String(v).trim() === "";
const DEPTO_COD = { "lomas de zamora": "lz", "quilmes": "ql" };
const depCod = (d) => DEPTO_COD[norm(d)] || norm(d).split(" ").map((w) => w[0]).join("").slice(0, 3) || "xx";

export function claveCausa(sistema, c) {
  const inc = vacio(c.inc) ? "" : `-i${String(c.inc).trim()}`;
  const anio = c.anio || "s-a";
  if (sistema === "PJN") return `pjn-${norm(c.fuero).replace(/ /g, "")}-${Number(c.numero)}-${anio}${inc}`;
  return `mev-${depCod(c.depto)}-${Number(c.numero)}-${anio}${inc}`;
}

/** Busca el origen de una causa en las filas de la planilla. Devuelve {origen,socio,porcentaje} o null. */
function origenDesdePlanilla(sistema, c, filasPlanilla) {
  const mismoOrigen = (cands) => {
    if (!cands.length) return null;
    const k = (x) => `${x.origen}|${x.socio}|${x.porcentaje}`;
    return cands.every((x) => k(x) === k(cands[0])) ? { origen: cands[0].origen, socio: cands[0].socio, porcentaje: cands[0].porcentaje, filas: cands } : false;
  };
  const delSistema = filasPlanilla.filter((f) => f.sistema === sistema);
  // 1) por numero (PJN: ademas fuero; MEV: ademas depto), solo si es unico o coinciden
  let cands = delSistema.filter((f) => Number(f.numero) === Number(c.numero)
    && (sistema === "PJN" ? norm(f.fuero) === norm(c.fuero) : norm(f.depto) === norm(c.depto)));
  if (!vacio(c.inc)) cands = cands.filter((f) => String(f.inc || "") === String(c.inc));
  let ambiguo = cands.length > 1;
  let r = mismoOrigen(cands);
  if (r) return r;
  // 2) por actor + demandado
  const a = norm(c.actor), d = norm(c.demandado);
  if (a && d) {
    const porNombre = delSistema.filter((f) => norm(f.actor) === a && norm(f.demandado) === d);
    if (porNombre.length > 1) ambiguo = true;
    r = mismoOrigen(porNombre);
    if (r) return r;
  }
  // null = la planilla no lista esta causa; {ambiguo} = la lista pero con origenes distintos
  return ambiguo ? { ambiguo: true } : null;
}

export async function sincronizarCasosLocal({ sistema, causas }) {
  let filasPlanilla = [];
  try {
    const { obtenerPlanilla } = await import("./planilla-causas.mjs");
    filasPlanilla = (await obtenerPlanilla()).filas || [];
  } catch { /* sin planilla: se sincroniza sin origen */ }

  const store = leerStore();
  let actualizados = 0, creados = 0, sinCambios = 0;
  const sinOrigen = [], errores = [];
  const usadas = new Set();
  const descartadas = [];
  const hoy = new Date().toISOString();

  for (const c of causas) {
    try {
      if (vacio(c.numero)) continue;
      const id = claveCausa(sistema, c);
      const o = origenDesdePlanilla(sistema, c, filasPlanilla);
      // La planilla es la fuente de la verdad: una causa que no figura en ella no es
      // tuya (p.ej. del feed de PJN) y se desestima. Solo si la planilla se pudo leer.
      if (filasPlanilla.length && o === null) {
        descartadas.push(`${c.numero}${c.inc ? "/inc" + c.inc : ""}`);
        if (store.casos[id]) delete store.casos[id];
        continue;
      }
      const ex = store.casos[id];
      const nuevo = ex ? JSON.parse(JSON.stringify(ex)) : { id, sistema, numero: String(Number(c.numero)), creado: hoy, novedades: [] };
      let cambio = !ex;

      // Campos de la causa: solo se completan si estan vacios.
      for (const k of ["fuero", "depto", "anio", "inc", "caratula", "actor", "demandado", "materia", "firma", "juzgado", "estado"]) {
        if (!vacio(c[k]) && vacio(nuevo[k])) { nuevo[k] = c[k]; cambio = true; }
      }

      // Origen/socio/porcentaje: la planilla manda, se sobrescribe.
      if (filasPlanilla.length && nuevo.enPlanilla !== true) { nuevo.enPlanilla = true; cambio = true; }
      if (o && !o.ambiguo) {
        for (const f of o.filas) usadas.add(f);
        for (const k of ["origen", "socio", "porcentaje"]) {
          if ((nuevo[k] ?? "") !== o[k]) { nuevo[k] = o[k]; cambio = true; }
        }
      } else {
        sinOrigen.push(`${c.numero}${c.inc ? "/inc" + c.inc : ""}`);
      }

      // Novedades (sin repetir) y ultima actuacion.
      const claves = new Set(nuevo.novedades.map((n) => `${n.fecha}|${n.descripcion}`));
      for (const n of c.novedadesNuevas || []) {
        if (claves.has(`${n.fecha}|${n.descripcion}`)) continue;
        nuevo.novedades.push({ ...n, resumen: n.resumen ?? null });
        claves.add(`${n.fecha}|${n.descripcion}`);
        cambio = true;
      }
      const ua = c.ultimaActuacion;
      if (ua && (!nuevo.ultimaActuacion || String(ua.fecha) > String(nuevo.ultimaActuacion.fecha || ""))) {
        nuevo.ultimaActuacion = { fecha: ua.fecha, descripcion: ua.descripcion, resumen: null };
        cambio = true;
      }

      if (!cambio) { sinCambios++; continue; }
      nuevo.actualizado = hoy;
      store.casos[id] = nuevo;
      if (ex) actualizados++; else creados++;
    } catch (e) {
      errores.push({ numero: c.numero, error: e.message });
    }
  }

  guardarStore(store);
  const planillaSinCausa = filasPlanilla.filter((f) => f.sistema === sistema && !usadas.has(f))
    .map((f) => `${f.hoja} ${f.numero}${f.inc ? "/inc" + f.inc : ""}`);
  return { actualizados, creados, sinCambios, ambiguos: [], errores, sinOrigen, descartadas, planillaSinCausa };
}
