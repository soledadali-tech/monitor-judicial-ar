/**
 * sync-supabase.mjs - Sincroniza la cartera (PJN/MEV) con la tabla public.casos de
 * Supabase que usa dashboard-legal, para que ese tablero muestre lo que el bot
 * encuentra sin depender de que alguien lo actualice a mano.
 *
 * DISEÑO DELIBERADAMENTE CONSERVADOR: la tabla ya tiene semanas de casos cargados a
 * mano (Claude Cowork, leyendo PDFs) con resumenes narrativos ("detalle",
 * "accionRecomendada", "fechasClave") que este bot NO puede generar (no lee ni
 * interpreta el fondo de cada actuacion, solo detecta que hubo una novedad). Reglas:
 *
 *   1. NUNCA arma un id a ciegas para actualizar: primero busca si ya existe un caso
 *      con ese sistema+numero. Si hay MAS DE UNO (tipico: una causa con incidentes,
 *      que comparten numero de expediente), NO TOCA NINGUNO — lo reporta como
 *      "ambiguo" para revisar a mano. Evita pisar el caso equivocado.
 *   2. Si hay exactamente un match: completa actor/demandado/materia/firma/juzgado/
 *      estado SOLO en las columnas que estan vacias en Supabase (igual que el patron
 *      "solo si vacia" del resto del repo). Nunca pisa lo que ya cargo Claude.
 *   3. Los campos narrativos (detalle, accionRecomendada, fechasClave, resumen de
 *      cada novedad/historial) NUNCA se tocan. Las "novedades" que detecta el bot se
 *      agregan a data.novedades con resumen:null (para que se note que es
 *      auto-generada, a diferencia de las que redacta Claude) y dedup por fecha+
 *      descripcion.
 *   4. Si NO existe ningun caso con ese numero, crea uno nuevo (con el id en el mismo
 *      formato que ya usa la tabla: "pjn-<fuero>-<numero>-<anio>" / "mev-<depto>-
 *      <numero>-<anio>") y lo marca con data._origen="monitor-judicial-ar" para que
 *      se note que no paso por Claude.
 *
 * Requiere SUPABASE_URL y SUPABASE_SERVICE_KEY en .env (la service_role: se salta
 * RLS, por eso es sensible). Si no estan configuradas, sincronizarCasos() es un no-op
 * (devuelve {nota:...}) para no romper el parte diario si todavia no se configuro.
 */

export function configSupabase() {
  const url = (process.env.SUPABASE_URL || "").trim();
  const key = (process.env.SUPABASE_SERVICE_KEY || "").trim();
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ""), key };
}

async function rest(cfg, path, { method = "GET", body, prefer } = {}) {
  const headers = { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${cfg.url}/rest/v1${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`Supabase ${method} ${path}: HTTP ${r.status} - ${(await r.text()).slice(0, 300)}`);
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim();
const DEPTO_COD = { "lomas de zamora": "lz", "quilmes": "ql" };
function depCod(depto) {
  const n = norm(depto);
  if (DEPTO_COD[n]) return DEPTO_COD[n];
  return n.split(" ").map((w) => w[0]).join("").slice(0, 3) || "xx"; // fallback: iniciales
}
function idPjn({ fuero, numero, anio }) {
  return `pjn-${norm(fuero).replace(/\s+/g, "")}-${Number(numero)}-${anio || "s-a"}`;
}
function idMev({ depto, numero, anio }) {
  return `mev-${depCod(depto)}-${Number(numero)}-${anio || "s-a"}`;
}

/** Busca casos existentes por sistema+numero (puede haber mas de uno: incidentes). */
async function buscarPorNumero(cfg, sistema, numero) {
  const q = `?sistema=eq.${encodeURIComponent(sistema)}&numero=eq.${encodeURIComponent(String(Number(numero)))}&select=id,data,actor,demandado,materia,firma,juzgado,estado,caratula`;
  return await rest(cfg, `/casos${q}`);
}

/**
 * Cuando un numero matchea mas de un caso (tipico: causa + incidentes, que comparten
 * numero de expediente), intenta desambiguar por "inc" (columna INC de la planilla:
 * vacio = causa principal, "1"/"2"/... = incidente N) contra el patron de caratula que
 * ya usa la tabla ("INCIDENTE Nº 1 - ..."). Si no hay "inc" disponible o el refinado
 * sigue dando mas de un candidato, devuelve null (sigue ambiguo, no se toca nada).
 */
function elegirCandidato(existentes, inc) {
  if (existentes.length <= 1) return existentes[0] || null;
  if (inc == null) return null; // sin dato para desambiguar: mejor no tocar nada
  const incTxt = String(inc).trim();
  const matches = existentes.filter((e) => {
    const esIncidente = /^\s*incidente/i.test(e.caratula || "");
    if (!incTxt) return !esIncidente; // causa principal
    return esIncidente && new RegExp(`incidente\\s*n[ºo°]?\\.?\\s*${incTxt}\\b`, "i").test(e.caratula || "");
  });
  return matches.length === 1 ? matches[0] : null;
}

const vacio = (v) => v == null || String(v).trim() === "";
// Solo agrega al PATCH las columnas que estan vacias en Supabase (nunca pisa).
function camposSiVacio(existente, nuevos) {
  const out = {};
  for (const [k, v] of Object.entries(nuevos)) {
    if (v == null || String(v).trim() === "") continue;
    if (vacio(existente[k])) out[k] = v;
  }
  return out;
}

function mergeNovedades(dataExistente, novedadesNuevas) {
  const actuales = Array.isArray(dataExistente?.novedades) ? dataExistente.novedades : [];
  const claves = new Set(actuales.map((n) => `${n.fecha}|${n.descripcion}`));
  const agregar = (novedadesNuevas || []).filter((n) => !claves.has(`${n.fecha}|${n.descripcion}`));
  return agregar.length ? [...actuales, ...agregar] : null;
}

/**
 * Sincroniza un frente completo. `causas`: [{
 *   numero, fuero (PJN) | depto (MEV), anio?, caratula, actor, demandado, materia,
 *   firma, juzgado?, estado?, mevUrl?, pjnUrl?,
 *   ultimaActuacion: {fecha,descripcion} | null,
 *   novedadesNuevas: [{fecha,descripcion,relevancia}],
 * }]. Devuelve { actualizados, creados, ambiguos, sinCambios, errores }.
 */
export async function sincronizarCasos({ sistema, causas }) {
  const cfg = configSupabase();
  if (!cfg) return { nota: "SUPABASE_URL/SUPABASE_SERVICE_KEY no configuradas en .env" };

  let actualizados = 0, creados = 0, sinCambios = 0;
  const ambiguos = [];
  const errores = [];

  for (const c of causas || []) {
    if (!c.numero) continue;
    try {
      const existentes = await buscarPorNumero(cfg, sistema, c.numero);
      const elegido = elegirCandidato(existentes, c.inc);
      if (existentes.length > 1 && !elegido) {
        ambiguos.push({ numero: c.numero, inc: c.inc ?? null, ids: existentes.map((e) => e.id) });
        continue;
      }

      if (elegido) {
        const ex = elegido;
        const patch = camposSiVacio(ex, {
          caratula: c.caratula, actor: c.actor, demandado: c.demandado,
          materia: c.materia, firma: c.firma, juzgado: c.juzgado, estado: c.estado,
        });
        const dataPatch = {};
        const novMerge = mergeNovedades(ex.data, c.novedadesNuevas);
        if (novMerge) dataPatch.novedades = novMerge;
        const uaExistente = ex.data?.ultimaActuacion;
        if (c.ultimaActuacion && (!uaExistente || String(c.ultimaActuacion.fecha) > String(uaExistente.fecha || ""))) {
          dataPatch.ultimaActuacion = { fecha: c.ultimaActuacion.fecha, descripcion: c.ultimaActuacion.descripcion, resumen: null };
        }
        if (c.mevUrl && vacio(ex.data?.mevUrl)) dataPatch.mevUrl = c.mevUrl;
        if (c.pjnUrl && vacio(ex.data?.pjnUrl)) dataPatch.pjnUrl = c.pjnUrl;

        if (!Object.keys(patch).length && !Object.keys(dataPatch).length) { sinCambios++; continue; }
        if (Object.keys(dataPatch).length) patch.data = { ...(ex.data || {}), ...dataPatch };
        patch.updated_at = new Date().toISOString();
        await rest(cfg, `/casos?id=eq.${encodeURIComponent(ex.id)}`, { method: "PATCH", body: patch, prefer: "return=minimal" });
        actualizados++;
        continue;
      }

      // No existe: crear. Requiere fuero (PJN) o depto (MEV) para armar el id.
      const id = sistema === "PJN" ? idPjn(c) : idMev(c);
      const data = {
        ultimaActuacion: c.ultimaActuacion ? { ...c.ultimaActuacion, resumen: null } : null,
        ultimaPresentacion: null, respuestaTribunal: null, accionRecomendada: null,
        historial: [], novedades: c.novedadesNuevas || [], fechasClave: [],
        error: null, mevUrl: c.mevUrl || null, pjnUrl: c.pjnUrl || null,
        _origen: "monitor-judicial-ar",
      };
      await rest(cfg, "/casos", {
        method: "POST",
        body: {
          id, sistema, numero: String(Number(c.numero)), caratula: c.caratula || null,
          actor: c.actor || null, demandado: c.demandado || null, juzgado: c.juzgado || null,
          estado: c.estado || null, materia: c.materia || null, firma: c.firma || null, data,
        },
        prefer: "return=minimal",
      });
      creados++;
    } catch (e) {
      errores.push({ numero: c.numero, error: e.message });
    }
  }

  return { actualizados, creados, sinCambios, ambiguos, errores };
}
