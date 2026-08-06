/**
 * cartera-mev.mjs - Cartera de causas de Provincia de Buenos Aires (MEV/SCBA)
 * en cartera-mev.xlsx.
 *
 * MODO HIBRIDO como el EJE, con una ventaja: la MEV tiene SETS server-side.
 * El bot siembra la cartera desde:
 *   - el set "Lista de Causas con AUTORIZACION" (causas reservadas autorizadas), y/o
 *   - los sets propios del usuario (MEV_SETS), y/o
 *   - busqueda por caratula (MEV_CRITERIOS) en organismos no penales.
 * La columna "Vigilar" depura homonimos igual que en el EJE (NO = no vigilar).
 *
 * Clave de causa: nidCausa + pidJuzgado (el nidCausa es unico por organismo).
 * Archivo PLANO para que exceljs lo reescriba sin romper nada. Requiere exceljs.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim();
function txt(v) { if (v == null) return ""; if (typeof v === "object") { if (v.result !== undefined) return String(v.result); if (v.text !== undefined) return String(v.text); return ""; } return String(v); }

export function carteraMevPath() { return process.env.CARTERA_MEV_XLSX || fileURLToPath(new URL("../cartera-mev.xlsx", import.meta.url)); }

const BOT_HEADERS = ["NidCausa", "PidJuzgado", "Organismo", "Jurisdiccion", "Fuero", "Caratula", "Estado",
  "Nro Expediente", "Nro Receptoria", "Fecha Inicio", "Ult. Paso", "Detalle Ult. Paso"];
// Columnas CALCULADAS por el bot en cada corrida (caducidad PBA + prescripcion penal). El
// bot las pisa siempre: son derivadas, no las carga el usuario. Van despues de las del bot.
const CALC_HEADERS = ["Caduc. Vence", "Caduc. Dias", "Caduc. Fase", "Caduc. Alerta", "Prescr. Vence", "Prescr. Dias", "Prescr. Alerta", "Plazos Actualizado"];
// Columnas de gestion del usuario. Alimentan caducidad-mev.mjs (art. 310/315 CPCC BA)
// y, a futuro, la prescripcion penal (pendiente de modulo propio para PBA).
const GESTION_HEADERS = ["Vigilar", "Ref/Cliente", "Fecha Impulso Real", "Caducidad Meses", "Caducidad Aplica",
  "Fecha Notif. Intimacion", "Delito (art. CP)", "Fecha Hecho", "Pena Max (anios)", "Ultima Interrupcion",
  "Prescripcion Aplica", "Observaciones"];
// Columnas que vienen de la planilla "LISTADO JUICIOS" (lib/planilla-causas.mjs). El bot
// las completa SOLO si estan vacias: lo cargado a mano nunca se pisa. "En Planilla" = SI
// cuando la fila matcheo con una fila de la planilla (ver aplicarPlanilla).
const PLANILLA_HEADERS = ["Actor", "Demandado", "Materia", "Firma", "En Planilla"];

/**
 * Fuero best-effort desde el ORGANISMO (los nombres del MEV son elocuentes) y la
 * jurisdiccion (si se entro con Fuero Penal / Familia). Orientativo, no vinculante.
 */
export function fueroDeOrganismo(organismo, jurisdiccion = "") {
  const o = norm(`${organismo} ${jurisdiccion}`);
  if (/penal|garant|correccional|casacion|ejecucion penal|responsabilidad penal juvenil|flagrancia/.test(o)) return "Penal";
  if (/trabajo|laboral/.test(o)) return "Laboral";
  if (/familia/.test(o)) return "Familia";
  if (/contencioso/.test(o)) return "Cont. Adm.";
  if (/\bpaz\b/.test(o)) return "Paz";
  if (/civil y comercial|civil|comercial/.test(o)) return "Civil y Comercial";
  return "";
}

const DESCARTAR = new Set(["no", "0", "false", "ignorar", "descartar", "ajena", "homonimo"]);
export function esVigilada(v) { return !DESCARTAR.has(norm(v)); }

const keyDe = (c) => `${String(c.nidCausa).trim()}|${String(c.pidJuzgado || "").trim()}`;

async function leerCarteraObj(ExcelJS, p) {
  let headersPrev = [];
  const filas = new Map();
  if (!fs.existsSync(p)) return { headersPrev, filas, existe: false };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  const ws = wb.worksheets[0];
  if (!ws) return { headersPrev, filas, existe: true };
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { headersPrev[i - 1] = String(c.text || "").trim(); });
  const iNid = headersPrev.findIndex((h) => /nidcausa|nid causa/.test(norm(h)));
  const iJuz = headersPrev.findIndex((h) => /pidjuzgado|pid juzgado/.test(norm(h)));
  for (let r = 2; r <= ws.rowCount; r++) {
    const o = {};
    headersPrev.forEach((h, i) => { if (h) o[h] = ws.getRow(r).getCell(i + 1).value; });
    const nid = txt(iNid >= 0 ? ws.getRow(r).getCell(iNid + 1).value : "").trim();
    const juz = txt(iJuz >= 0 ? ws.getRow(r).getCell(iJuz + 1).value : "").trim();
    if (nid) filas.set(`${nid}|${juz}`, o);
  }
  return { headersPrev, filas, existe: true };
}

/**
 * Agrega/actualiza causas. causas: [{nidCausa,pidJuzgado,organismo,jurisdiccion,caratula,
 * estado,expediente,receptoria,fechaInicio,ultimoMovimiento:{fecha,descripcion}}].
 * Preserva las columnas de gestion cargadas por el usuario.
 */
export async function upsertCausas({ causas }) {
  let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch { return { nota: "falta exceljs (npm i exceljs)" }; }
  const p = carteraMevPath();
  const { headersPrev, filas } = await leerCarteraObj(ExcelJS, p);

  const H = { nid: "NidCausa", juz: "PidJuzgado", org: "Organismo", jur: "Jurisdiccion", fue: "Fuero", car: "Caratula",
    est: "Estado", exp: "Nro Expediente", rec: "Nro Receptoria", ini: "Fecha Inicio", ult: "Ult. Paso", det: "Detalle Ult. Paso", vig: "Vigilar" };
  // Columnas de planilla (ver lib/planilla-causas.mjs / aplicarPlanilla): opcionales
  // aca. Sirven para cuando quien llama (ej. la busqueda activa por actor+demandado
  // de descubrir-mev.mjs) YA sabe estos datos de la planilla y el cruce normal por
  // numero no los va a poder completar despues (el "Nro Expediente" real de la MEV no
  // siempre coincide con el NUMERO de la planilla).
  const HP = { act: "Actor", dem: "Demandado", mat: "Materia", fir: "Firma", enPl: "En Planilla" };
  const setSiVacio = (o, h, v) => { if (!txt(o[h]) && v != null && String(v).trim() !== "") o[h] = v; };

  let nuevas = 0, actualizadas = 0;
  for (const c of causas || []) {
    if (!c || c.nidCausa == null) continue;
    const k = keyDe(c);
    const um = c.ultimoMovimiento || {};
    if (filas.has(k)) {
      const o = filas.get(k);
      setSiVacio(o, H.car, c.caratula);
      setSiVacio(o, H.org, c.organismo);
      setSiVacio(o, H.jur, c.jurisdiccion);
      setSiVacio(o, H.fue, fueroDeOrganismo(c.organismo || txt(o[H.org]), c.jurisdiccion || txt(o[H.jur])));
      if (c.estado) o[H.est] = c.estado;
      setSiVacio(o, H.exp, c.expediente);
      setSiVacio(o, H.rec, c.receptoria);
      setSiVacio(o, H.ini, c.fechaInicio);
      if (um.fecha) o[H.ult] = um.fecha;
      if (um.descripcion) o[H.det] = um.descripcion;
      setSiVacio(o, HP.act, c.actor); setSiVacio(o, HP.dem, c.demandado);
      setSiVacio(o, HP.mat, c.materia); setSiVacio(o, HP.fir, c.firma);
      if (c.actor || c.demandado) o[HP.enPl] = "SI";
      actualizadas++;
    } else {
      filas.set(k, {
        [H.nid]: String(c.nidCausa), [H.juz]: String(c.pidJuzgado || ""), [H.org]: c.organismo || "",
        [H.jur]: c.jurisdiccion || "", [H.fue]: fueroDeOrganismo(c.organismo || "", c.jurisdiccion || ""),
        [H.car]: c.caratula || "", [H.est]: c.estado || "", [H.exp]: c.expediente || "",
        [H.rec]: c.receptoria || "", [H.ini]: c.fechaInicio || "",
        [H.ult]: um.fecha || "", [H.det]: um.descripcion || "",
        [H.vig]: "", // en blanco = vigilada; "NO" = homonimo/ajena.
        [HP.act]: c.actor || "", [HP.dem]: c.demandado || "", [HP.mat]: c.materia || "", [HP.fir]: c.firma || "",
        [HP.enPl]: (c.actor || c.demandado) ? "SI" : "",
      });
      nuevas++;
    }
  }

  const conocidas = [...BOT_HEADERS, ...CALC_HEADERS];
  const prev = headersPrev.filter(Boolean);
  const extras = prev.filter((h) => !conocidas.some((b) => norm(b) === norm(h)));
  const faltantes = GESTION_HEADERS.filter((g) => !extras.some((e) => norm(e) === norm(g)) && !conocidas.some((b) => norm(b) === norm(g)));
  const faltantesPlanilla = PLANILLA_HEADERS.filter((g) => !extras.some((e) => norm(e) === norm(g)) && !conocidas.some((b) => norm(b) === norm(g)));
  const headers = [...BOT_HEADERS, ...CALC_HEADERS, ...extras, ...faltantes, ...faltantesPlanilla];

  const lista = [...filas.values()].sort((a, b) => txt(a["Caratula"]).localeCompare(txt(b["Caratula"])));
  const wb2 = new ExcelJS.Workbook();
  const ws2 = wb2.addWorksheet("CAUSAS PBA");
  ws2.addRow(headers);
  ws2.getRow(1).font = { bold: true };
  for (const o of lista) ws2.addRow(headers.map((h) => { const v = o[h]; return (v && typeof v === "object" && v.result !== undefined) ? v.result : (v ?? null); }));
  await wb2.xlsx.writeFile(p);
  return { nuevas, actualizadas, total: lista.length, archivo: p };
}

// ─── volcado de plazos calculados a cartera-mev.xlsx ──────────────────────────
// Escribe en cada fila el vencimiento de caducidad (art. 310/315 CPCC BA) y de prescripcion
// penal. Se llama con los arrays "todas" (no solo las en riesgo). Match por nidCausa|pidJuzgado.
const fmtDiaD = (d) => d instanceof Date && !isNaN(d) ? new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric" }).format(d) : "";
const faseCaducPba = { intimada: "INTIMADA", habilitado: "PLAZO CUMPLIDO", encurso: "en curso" };
const alertaCaducPba = { vencido: "PERENTORIO VENCIDO", urgente: "URGENTE", preventivo: "preventivo", habilitado: "PLAZO CUMPLIDO", lejano: "en termino" };
const alertaPrescrPba = { prescripto: "POSIBLE PRESCRIPCION OPERADA", urgente: "URGENTE", preventivo: "preventivo", lejano: "en termino" };
const keyCalc = (it) => `${String(it.nidCausa ?? "").trim()}|${String(it.pidJuzgado ?? "").trim()}`;

export async function volcarCalculos({ caducidad = [], prescripcion = [] } = {}) {
  let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch { return { nota: "falta exceljs" }; }
  const p = carteraMevPath();
  if (!fs.existsSync(p)) return { nota: "sin cartera-mev.xlsx" };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  const ws = wb.worksheets[0];
  if (!ws) return { nota: "sin hoja" };

  const headers = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { headers[i - 1] = String(c.text || "").trim(); });
  const iNid = headers.findIndex((h) => /nidcausa|nid causa/.test(norm(h)));
  const iJuz = headers.findIndex((h) => /pidjuzgado|pid juzgado/.test(norm(h)));
  if (iNid < 0) return { nota: "cartera-mev sin columna NidCausa" };
  for (const h of CALC_HEADERS) if (!headers.some((x) => norm(x) === norm(h))) { headers.push(h); ws.getRow(1).getCell(headers.length).value = h; }
  ws.getRow(1).font = { bold: true };
  const ci = (name) => headers.findIndex((h) => norm(h) === norm(name)) + 1;
  const cCadV = ci("Caduc. Vence"), cCadD = ci("Caduc. Dias"), cCadF = ci("Caduc. Fase"), cCadA = ci("Caduc. Alerta");
  const cPreV = ci("Prescr. Vence"), cPreD = ci("Prescr. Dias"), cPreA = ci("Prescr. Alerta"), cAct = ci("Plazos Actualizado");
  // Columnas de entrada penal: el bot las auto-completa (marca [auto]) SOLO si estan vacias,
  // con el delito/pena que dedujo de la caratula. Lo cargado a mano NUNCA se pisa.
  const ciBusca = (pred) => headers.findIndex((h) => pred(norm(h))) + 1;
  const cDelito = ciBusca((x) => x.includes("delito"));
  const cPenaMax = ciBusca((x) => x.includes("pena") && x.includes("max"));

  const mCad = new Map(); for (const it of caducidad) mCad.set(keyCalc(it), it);
  const mPre = new Map(); for (const it of prescripcion) mPre.set(keyCalc(it), it);
  const hoyTxt = fmtDiaD(new Date());

  let escritas = 0;
  for (let r = 2; r <= ws.rowCount; r++) {
    const nid = txt(ws.getRow(r).getCell(iNid + 1).value).trim();
    if (!nid) continue;
    const juz = iJuz >= 0 ? txt(ws.getRow(r).getCell(iJuz + 1).value).trim() : "";
    const k = `${nid}|${juz}`;
    const cad = mCad.get(k), pre = mPre.get(k);
    const row = ws.getRow(r);
    row.getCell(cCadV).value = cad ? fmtDiaD(cad.venc) : "";
    row.getCell(cCadD).value = cad ? cad.restan : "";
    row.getCell(cCadF).value = cad ? (faseCaducPba[cad.fase] || cad.fase || "") : "";
    row.getCell(cCadA).value = cad ? (alertaCaducPba[cad.nivel] || cad.nivel || "") : "";
    // Prescripcion: con computo -> fecha/dias/alerta; sin datos suficientes -> nota de que falta.
    row.getCell(cPreV).value = (pre && !pre.faltaDato) ? fmtDiaD(pre.venc) : "";
    row.getCell(cPreD).value = (pre && !pre.faltaDato) ? pre.restan : "";
    row.getCell(cPreA).value = pre ? (pre.faltaDato ? pre.motivo : (alertaPrescrPba[pre.nivel] || pre.nivel || "")) : "";
    // Auto-completar delito y pena deducidos de la caratula, solo en celdas vacias.
    if (pre && pre.art && cDelito && !txt(row.getCell(cDelito).value).trim()) {
      row.getCell(cDelito).value = `${pre.art} [auto]`;
    }
    if (pre && cPenaMax && Number.isFinite(pre.penaMax) && pre.penaFuente === "tabla" && !txt(row.getCell(cPenaMax).value).trim()) {
      row.getCell(cPenaMax).value = pre.penaMax;
    }
    row.getCell(cAct).value = (cad || pre) ? hoyTxt : "";
    if (cad || pre) escritas++;
  }
  await wb.xlsx.writeFile(p);
  return { escritas, archivo: p };
}

/**
 * Causas a vigilar (Vigilar != NO Y "En Planilla" = SI). Devuelve [{key,nidCausa,
 * pidJuzgado,organismo,jurisdiccion,fuero,caratula,estado,ultPasoFecha}].
 *
 * Se exige "En Planilla"=SI ademas de Vigilar!=NO porque el set "Lista de Causas
 * con AUTORIZACION" del portal MEV puede traer causas que NO son de esta usuaria
 * (comparte el estudio jurídico con otros abogados que firman causas propias, y el
 * login MEV puede ver causas de otros socios) — sin la planilla LISTADO JUICIOS
 * como filtro, esas causas ajenas terminaban en el parte diario como si fueran
 * propias. Confirmado en vivo: 2 causas de Familia (divorcio/alimentos, un fuero
 * que la planilla no cubre) aparecian en el reporte de caducidad sin ser de la
 * usuaria. "En Planilla" lo pone en SI upsertCausas() en cuanto la causa matchea
 * con la planilla (por numero+depto o por la busqueda activa), asi que una causa
 * genuina de la usuaria SIEMPRE termina con ese flag — no hay falso descarte.
 */
export async function leerVigiladas() {
  let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch { return { causas: [], nota: "falta exceljs" }; }
  const p = carteraMevPath();
  const { filas, existe } = await leerCarteraObj(ExcelJS, p);
  if (!existe) return { causas: [], nota: "cartera-mev.xlsx todavia no existe (correr descubrir-mev.mjs)" };
  const out = [];
  let descartadasSinPlanilla = 0;
  for (const [k, o] of filas) {
    if (!esVigilada(txt(o["Vigilar"]))) continue;
    const nid = txt(o["NidCausa"]).trim();
    if (!nid) continue;
    if (norm(txt(o["En Planilla"])) !== "si") { descartadasSinPlanilla++; continue; }
    out.push({
      key: k, nidCausa: nid, pidJuzgado: txt(o["PidJuzgado"]).trim(),
      organismo: txt(o["Organismo"]), jurisdiccion: txt(o["Jurisdiccion"]), fuero: txt(o["Fuero"]),
      caratula: txt(o["Caratula"]), estado: txt(o["Estado"]), ultPasoFecha: txt(o["Ult. Paso"]),
    });
  }
  return { causas: out, archivo: p, descartadasSinPlanilla };
}

// ─── cruce con la planilla "LISTADO JUICIOS" ──────────────────────────────────
// La planilla NO trae año para las causas de la MEV (a diferencia de la de PJN), asi que
// el cruce es por numero de expediente + departamento judicial.
// "Nro Expediente" sale de mev-client.parseListado como "COD - NUMERO - AÑO"; para las
// filas agregadas por esta misma funcion (sin scraping todavia) queda solo el numero.
export function extraerNumeroMev(expTxt) {
  const s = String(expTxt || "");
  const conGuiones = s.match(/[A-Z]{1,3}\s*-\s*(\d{1,7})\s*-\s*\d{2,4}/i);
  if (conGuiones) return String(Number(conGuiones[1]));
  const suelto = s.match(/(\d{1,7})/);
  return suelto ? String(Number(suelto[1])) : null;
}
// "Jurisdiccion" guarda la clave de descubrir-mev.mjs, ej. "Lomas de Zamora:penal".
// El depto es la parte antes de los ":".
export const deptoDeJurisdiccion = (jur) => String(jur || "").split(":")[0].trim();

/**
 * Cruza la cartera con las filas MEV de la planilla (lib/planilla-causas.mjs):
 *  - completa Actor/Demandado/Materia/Firma SOLO en celdas vacias y marca "En Planilla"=SI
 *    en las filas de la cartera que matchean por numero de expediente + departamento.
 *  - agrega como fila nueva las causas de la planilla que la cartera todavia no tiene
 *    (no se sembraron/autorizaron todavia en el portal), con una clave sintetica
 *    "PLANILLA:<depto>:<numero>" en NidCausa/PidJuzgado para poder identificarlas.
 *  - si una fila de la planilla podria matchear mas de una fila de la cartera (mismo
 *    numero en el mismo depto, distinto organismo/fuero), no toca ninguna: la reporta
 *    en "ambiguas" para revisar a mano.
 * Devuelve { matcheadas, agregadas, ambiguas, archivo }.
 */
export async function aplicarPlanilla(filasPlanillaMev) {
  let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch { return { nota: "falta exceljs" }; }
  const p = carteraMevPath();
  if (!fs.existsSync(p)) return { nota: "sin cartera-mev.xlsx (correr descubrir-mev.mjs primero)" };
  if (!filasPlanillaMev || !filasPlanillaMev.length) return { matcheadas: 0, agregadas: 0, ambiguas: [], archivo: p };

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  const ws = wb.worksheets[0];
  if (!ws) return { nota: "sin hoja" };

  const headers = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { headers[i - 1] = String(c.text || "").trim(); });
  const iExp = headers.findIndex((h) => /nro expediente/.test(norm(h)));
  const iJur = headers.findIndex((h) => /jurisdiccion/.test(norm(h)));
  const iNid = headers.findIndex((h) => /nidcausa|nid causa/.test(norm(h)));
  const iJuz = headers.findIndex((h) => /pidjuzgado|pid juzgado/.test(norm(h)));
  if (iExp < 0 || iJur < 0 || iNid < 0) return { nota: "cartera-mev sin columnas esperadas (Nro Expediente/Jurisdiccion/NidCausa)" };
  for (const h of PLANILLA_HEADERS) if (!headers.some((x) => norm(x) === norm(h))) { headers.push(h); ws.getRow(1).getCell(headers.length).value = h; }
  ws.getRow(1).font = { bold: true };
  const ci = (name) => headers.findIndex((h) => norm(h) === norm(name)) + 1;
  const cAct = ci("Actor"), cDem = ci("Demandado"), cMat = ci("Materia"), cFir = ci("Firma"), cEnPl = ci("En Planilla");
  const cCar = ci("Caratula"), cFue = ci("Fuero"), cOrg = ci("Organismo"), cVig = ci("Vigilar"), cObs = ci("Observaciones");

  // Indice de filas de cartera por numero|depto (depto normalizado sin acentos).
  const porNumDepto = new Map();
  for (let r = 2; r <= ws.rowCount; r++) {
    const numero = extraerNumeroMev(ws.getRow(r).getCell(iExp + 1).value);
    const depto = norm(deptoDeJurisdiccion(ws.getRow(r).getCell(iJur + 1).value));
    if (!numero || !depto) continue;
    const k = `${numero}|${depto}`;
    if (!porNumDepto.has(k)) porNumDepto.set(k, []);
    porNumDepto.get(k).push(r);
  }

  const strCell = (v) => v == null ? "" : (typeof v === "object" ? (v.result ?? v.text ?? "") : v).toString().trim();
  const setSiVacio = (row, col, v) => { if (col && v && !strCell(row.getCell(col).value)) row.getCell(col).value = v; };

  // Indice secundario por actor+demandado+tipo(beneficio/principal), SOLO de filas
  // reales (nidCausa numerico, no "PLANILLA:..."). El "Nro Expediente" real de la MEV
  // no siempre coincide con el NUMERO de la planilla (ver descubrir-mev.mjs), asi que
  // una causa ya resuelta por la busqueda activa por actor+demandado no va a matchear
  // por numero aca — sin este indice, se le agregaria un stub duplicado de nuevo.
  const esBenef = (m) => /beneficio/i.test(m || "") ? "benef" : "main";
  const porActorDem = new Map();
  for (let r = 2; r <= ws.rowCount; r++) {
    const nid = strCell(ws.getRow(r).getCell(iNid + 1).value);
    if (!nid || nid.startsWith("PLANILLA:")) continue;
    const act = cAct ? norm(strCell(ws.getRow(r).getCell(cAct).value)) : "";
    const dem = cDem ? norm(strCell(ws.getRow(r).getCell(cDem).value)) : "";
    if (!act || !dem) continue;
    const mat = cMat ? strCell(ws.getRow(r).getCell(cMat).value) : "";
    const k2 = `${act}|${dem}|${esBenef(mat)}`;
    if (!porActorDem.has(k2)) porActorDem.set(k2, []);
    porActorDem.get(k2).push(r);
  }

  let matcheadas = 0, agregadas = 0;
  const ambiguas = [];
  const filasNuevas = [];
  for (const f of filasPlanillaMev) {
    const numero = String(Number(f.numero));
    const depto = norm(f.depto);
    if (!depto) continue; // sin depto no hay forma confiable de ubicarla
    const k = `${numero}|${depto}`;
    const candidatos = porNumDepto.get(k) || [];
    if (candidatos.length > 1) { ambiguas.push({ depto: f.depto, numero: f.numero, filas: candidatos }); continue; }
    if (candidatos.length === 1) {
      const row = ws.getRow(candidatos[0]);
      setSiVacio(row, cAct, f.actor);
      setSiVacio(row, cDem, f.demandado);
      setSiVacio(row, cMat, f.materia);
      setSiVacio(row, cFir, f.firma);
      if (cEnPl) row.getCell(cEnPl).value = "SI";
      matcheadas++;
      continue;
    }
    const k2 = `${norm(f.actor)}|${norm(f.demandado)}|${esBenef(f.materia)}`;
    const yaResuelta = porActorDem.get(k2);
    if (yaResuelta && yaResuelta.length === 1) {
      const row = ws.getRow(yaResuelta[0]);
      setSiVacio(row, cMat, f.materia);
      setSiVacio(row, cFir, f.firma);
      matcheadas++;
      continue;
    }
    filasNuevas.push(f);
  }

  for (const f of filasNuevas) {
    const claveSint = `PLANILLA:${f.depto}:${f.numero}`;
    const row = ws.getRow(ws.rowCount + 1);
    row.getCell(iNid + 1).value = claveSint;
    if (iJuz >= 0) row.getCell(iJuz + 1).value = "";
    row.getCell(iExp + 1).value = f.numero;
    row.getCell(iJur + 1).value = f.depto;
    if (cFue && f.fuero) row.getCell(cFue).value = f.fuero;
    if (cOrg && f.tribunal) row.getCell(cOrg).value = `Juzgado/Tribunal Nº ${f.tribunal}`;
    if (cCar) row.getCell(cCar).value = f.actor && f.demandado ? `${f.actor} C/ ${f.demandado}${f.materia ? " S/ " + f.materia : ""}` : "";
    if (cAct) row.getCell(cAct).value = f.actor;
    if (cDem) row.getCell(cDem).value = f.demandado;
    if (cMat) row.getCell(cMat).value = f.materia;
    if (cFir) row.getCell(cFir).value = f.firma;
    if (cEnPl) row.getCell(cEnPl).value = "SI";
    // Vigilar=NO: es una fila SOLO informativa (no tiene nidCausa real, no se puede
    // consultar en el portal). Cuando descubrir-mev.mjs la encuentre de verdad va a
    // crear una fila aparte con su NidCausa real; ahi se puede borrar esta y listo.
    if (cVig) row.getCell(cVig).value = "NO";
    if (cObs) row.getCell(cObs).value = "Agregada desde planilla, todavia sin encontrar en el portal (Vigilar=NO a proposito). Sembrar/autorizar en la MEV y correr descubrir-mev.mjs; cuando aparezca con su NidCausa real, borrar esta fila.";
    agregadas++;
  }

  await wb.xlsx.writeFile(p);
  return { matcheadas, agregadas, ambiguas, archivo: p };
}

// ─── lectura para sync-supabase.mjs ───────────────────────────────────────────
/**
 * Filas VIGILADAS de la cartera en formato listo para lib/sync-supabase.mjs: [{
 *   numero, depto, anio (de "Fecha Inicio" si esta cargada; puede faltar), caratula,
 *   actor, demandado, materia, firma, juzgado, estado
 * }]. Excluye las filas "solo planilla" (Vigilar=NO, sin NidCausa real: no tiene
 * sentido subirlas a Supabase todavia, no son datos confirmados en el portal).
 */
export async function filasParaSync() {
  let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch { return []; }
  const p = carteraMevPath();
  if (!fs.existsSync(p)) return [];
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const headers = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { headers[i - 1] = String(c.text || "").trim(); });
  const ci = (name) => headers.findIndex((h) => norm(h) === norm(name)) + 1;
  const iExp = ci("Nro Expediente"), iRec = ci("Nro Receptoria"), iJur = ci("Jurisdiccion"), iNid = ci("NidCausa"), iVig = ci("Vigilar"), iEnPl = ci("En Planilla");
  const cCar = ci("Caratula"), cAct = ci("Actor"), cDem = ci("Demandado"), cMat = ci("Materia"), cFir = ci("Firma");
  const cOrg = ci("Organismo"), cEst = ci("Estado"), cIni = ci("Fecha Inicio");
  const strCell = (v) => v == null ? "" : (typeof v === "object" ? (v.result ?? v.text ?? "") : v).toString().trim();
  if (!iExp || !iJur) return [];
  const out = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const nid = iNid ? strCell(ws.getRow(r).getCell(iNid).value) : "";
    if (!nid || nid.startsWith("PLANILLA:")) continue; // sin confirmar en el portal
    if (iVig && !esVigilada(strCell(ws.getRow(r).getCell(iVig).value))) continue;
    // Mismo filtro que leerVigiladas(): sin "En Planilla"=SI puede ser una causa
    // ajena que se coló por el set compartido del portal (ver esa funcion).
    if (iEnPl && norm(strCell(ws.getRow(r).getCell(iEnPl).value)) !== "si") continue;
    // "Nro Expediente" puede quedar vacio para causas resueltas por la busqueda
    // activa por numero (mev-busqueda-planilla.mjs): el listado de la MEV a veces
    // solo trae Receptoria para esos resultados. Sin este respaldo, esas causas
    // quedaban afuera del sync a Supabase (confirmado en vivo: sincronizaron 3 de 19).
    const expTxt = strCell(ws.getRow(r).getCell(iExp).value);
    const recTxt = iRec ? strCell(ws.getRow(r).getCell(iRec).value) : "";
    const numero = extraerNumeroMev(expTxt) || extraerNumeroMev(recTxt);
    const depto = deptoDeJurisdiccion(ws.getRow(r).getCell(iJur).value);
    if (!numero || !depto) continue;
    const ini = cIni ? strCell(ws.getRow(r).getCell(cIni).value) : "";
    const mAnioIni = ini.match(/\d{1,2}\/\d{1,2}\/(\d{2,4})/);
    const mAnioExp = (expTxt + " " + recTxt).match(/[A-Z]{1,3}\s*-\s*\d{1,7}\s*-\s*(\d{2,4})/i);
    const anioBruto = (mAnioIni && mAnioIni[1]) || (mAnioExp && mAnioExp[1]) || null;
    out.push({
      numero, depto, anio: anioBruto ? (anioBruto.length >= 4 ? anioBruto : `20${anioBruto}`) : null,
      caratula: cCar ? strCell(ws.getRow(r).getCell(cCar).value) : "",
      actor: cAct ? strCell(ws.getRow(r).getCell(cAct).value) : "",
      demandado: cDem ? strCell(ws.getRow(r).getCell(cDem).value) : "",
      materia: cMat ? strCell(ws.getRow(r).getCell(cMat).value) : "",
      firma: cFir ? strCell(ws.getRow(r).getCell(cFir).value) : "",
      juzgado: cOrg ? strCell(ws.getRow(r).getCell(cOrg).value) : "",
      estado: cEst ? strCell(ws.getRow(r).getCell(cEst).value) : "",
    });
  }
  return out;
}

// ─── busqueda activa en el portal por lo que la planilla conoce y no se encontro ──
/**
 * Filas "solo planilla" (NidCausa = "PLANILLA:<depto>:<numero>", agregadas por
 * aplicarPlanilla): causas que la planilla dice que existen pero el barrido de sets
 * autorizados no encontro. Devuelve lo necesario para buscarlas activamente por
 * actor+demandado en el portal (ver buscar-planilla-mev en descubrir-mev.mjs):
 * [{ nidStub, depto, fuero, tribunal, numeroPlanilla, actor, demandado, materia, firma }].
 */
export async function filasPlanillaPendientes() {
  let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch { return []; }
  const p = carteraMevPath();
  if (!fs.existsSync(p)) return [];
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const headers = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { headers[i - 1] = String(c.text || "").trim(); });
  const ci = (name) => headers.findIndex((h) => norm(h) === norm(name)) + 1;
  const iNid = ci("NidCausa"), iJur = ci("Jurisdiccion"), cFue = ci("Fuero"), cOrg = ci("Organismo"), cExp = ci("Nro Expediente");
  const cAct = ci("Actor"), cDem = ci("Demandado"), cMat = ci("Materia"), cFir = ci("Firma");
  if (!iNid) return [];
  const out = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const nidStub = txt(ws.getRow(r).getCell(iNid).value).trim();
    if (!nidStub.startsWith("PLANILLA:")) continue;
    const tribM = cOrg ? txt(ws.getRow(r).getCell(cOrg).value).match(/(\d+)/) : null;
    out.push({
      nidStub,
      depto: iJur ? txt(ws.getRow(r).getCell(iJur).value).trim() : "",
      fuero: cFue ? txt(ws.getRow(r).getCell(cFue).value).trim() : "",
      tribunal: tribM ? tribM[1] : "",
      numeroPlanilla: cExp ? txt(ws.getRow(r).getCell(cExp).value).trim() : "",
      actor: cAct ? txt(ws.getRow(r).getCell(cAct).value).trim() : "",
      demandado: cDem ? txt(ws.getRow(r).getCell(cDem).value).trim() : "",
      materia: cMat ? txt(ws.getRow(r).getCell(cMat).value).trim() : "",
      firma: cFir ? txt(ws.getRow(r).getCell(cFir).value).trim() : "",
    });
  }
  return out;
}

/** Borra filas "solo planilla" (por su NidCausa sintetico exacto) ya superadas por un match real. */
export async function eliminarStubs(nidStubs) {
  if (!nidStubs || !nidStubs.length) return { borradas: 0 };
  let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch { return { borradas: 0 }; }
  const p = carteraMevPath();
  if (!fs.existsSync(p)) return { borradas: 0 };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  const ws = wb.worksheets[0];
  if (!ws) return { borradas: 0 };
  const headers = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { headers[i - 1] = String(c.text || "").trim(); });
  const iNid = headers.findIndex((h) => norm(h) === norm("NidCausa")) + 1;
  if (!iNid) return { borradas: 0 };
  const set = new Set(nidStubs);
  const filasABorrar = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    if (set.has(txt(ws.getRow(r).getCell(iNid).value).trim())) filasABorrar.push(r);
  }
  for (const r of filasABorrar.reverse()) ws.spliceRows(r, 1);
  if (filasABorrar.length) await wb.xlsx.writeFile(p);
  return { borradas: filasABorrar.length };
}
