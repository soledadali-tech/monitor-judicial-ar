/**
 * cartera.mjs - Registro de causas AUTOCOMPLETADO por el bot (cartera-pjn.xlsx).
 *
 * El bot crea y mantiene este archivo PLANO (sin formato condicional ni graficos,
 * asi exceljs lo puede reescribir sin romper nada). En cada corrida:
 *   - Agrega las causas nuevas que aparecen en el feed.
 *   - Actualiza caratula, fuero y "Ult. Movimiento" de las que ya estan.
 *   - CONSERVA intactas las columnas de gestion que vos completes (Cliente, Abogado,
 *     Fecha Impulso Real, Plazo Meses, Estado, etc.): las lee y las vuelve a escribir.
 *
 * Este es tu registro de causas vivo. Tu GestionEstudioJuridico.xlsx (con dashboards
 * y colores) queda aparte; el bot no lo toca. Caducidad y penal leen este archivo.
 *
 * Requiere: npm i exceljs.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const FUEROS = {
  CIV: "Nac. Civil", COM: "Nac. Comercial", CNT: "Nac. del Trabajo",
  CSS: "Fed. Seguridad Social", CCC: "Nac. Criminal y Correccional",
  CFP: "Fed. Criminal y Correccional", CPE: "Nac. Penal Economico",
  CPF: "Fed. Casacion Penal", CPN: "Nac. Casacion Penal", CAF: "Fed. Cont. Adm.",
  CNE: "Nac. Electoral", CCF: "Fed. Civil y Comercial",
};
function fueroDe(clave) { const m = (clave || "").trim().match(/^([A-Z]{2,4})\b/); const cod = m ? m[1] : "OTROS"; return FUEROS[cod] || cod; }
const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim();
function normExp(s) { const m = String(s ?? "").match(/(\d{1,7})\s*\/\s*(\d{2,4})/); return m ? `${m[1]}/${m[2]}` : String(s ?? "").toUpperCase().replace(/\s+/g, "").replace(/[^\dA-Z/]/g, ""); }
const fmtDia = (ms) => new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(ms));
function parseFechaAr(s) { const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (!m) return null; const a = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); const d = new Date(a, Number(m[2]) - 1, Number(m[1])); return isNaN(d) ? null : d; }
function txt(cell) { const v = cell && cell.value; if (v == null) return ""; if (typeof v === "object") { if (v.result !== undefined) return String(v.result); if (v.text !== undefined) return String(v.text); } return String(v); }

export function carteraPath() { return process.env.CARTERA_XLSX || fileURLToPath(new URL("../cartera-pjn.xlsx", import.meta.url)); }

const BOT_HEADERS = ["Nro. Causa", "Caratula", "Fuero", "Primera vez", "Ult. Movimiento"];
// Columnas CALCULADAS por el bot en cada corrida (caducidad + prescripcion). El bot las
// pisa siempre: son derivadas, no las carga el usuario. Van justo despues de las del feed.
const CALC_HEADERS = ["Caduc. Vence", "Caduc. Dias", "Caduc. Alerta", "Prescr. Vence", "Prescr. Dias", "Prescr. Alerta", "Plazos Actualizado"];
const GESTION_HEADERS = ["Estado", "Fecha Impulso Real", "Plazo Meses", "Susp Desde", "Susp Hasta", "Prescripcion Anios", "Pena Max Anios", "Delito (art. CP)", "Fecha Hecho", "Ultimo Acto Interruptivo", "Observaciones"];
// Columnas que vienen de la planilla "LISTADO JUICIOS" (lib/planilla-causas.mjs). El bot
// las completa SOLO si estan vacias (igual que en excel-writeback): lo cargado a mano
// nunca se pisa. "En Planilla" = SI cuando la fila matcheo con una fila de la planilla.
const PLANILLA_HEADERS = ["Actor", "Demandado", "Materia", "Firma", "En Planilla"];

const idx = (headers, rx) => headers.findIndex((h) => rx.test(norm(h)));
const idxNro = (headers) => headers.findIndex((h) => /nro|causa|exped/.test(norm(h)));

function agruparFeed(nuevos) {
  const feed = new Map();
  for (const it of nuevos || []) {
    const clave = String(it.payload?.claveExpediente || "").trim(); if (!clave) continue;
    const f = new Date(it.fechaAccion || it.fechaCreacion || Date.now());
    const car = it.payload?.caratulaExpediente || "";
    if (!feed.has(clave)) feed.set(clave, { clave, caratula: car, fuero: fueroDe(clave), min: f, max: f });
    else { const g = feed.get(clave); if (f < g.min) g.min = f; if (f > g.max) g.max = f; if (!g.caratula && car) g.caratula = car; }
  }
  return feed;
}

export async function actualizarCartera({ nuevos }) {
  let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch { return { nota: "falta exceljs" }; }
  const p = carteraPath();
  const feed = agruparFeed(nuevos);
  const hNro = "Nro. Causa", hCar = "Caratula", hFue = "Fuero", hPri = "Primera vez", hUlt = "Ult. Movimiento", hEst = "Estado";
  const str = (v) => v == null ? "" : (typeof v === "object" ? (v.result ?? v.text ?? "") : v).toString().trim();
  // Clave = expediente COMPLETO (incluye sub-legajo /TO1/3, /CA1). NO usar normExp aca:
  // colapsaria los legajos del mismo expediente base y perderia filas.
  const keyClave = (s) => str(s).toUpperCase().replace(/\s+/g, " ");

  // Leer existentes como objetos por encabezado (preserva columnas de gestion).
  let headersPrev = [];
  const filas = new Map(); // normExp(nro) -> { [header]: value }
  if (fs.existsSync(p)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(p);
    const ws = wb.worksheets[0];
    if (ws) {
      ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { headersPrev[i - 1] = String(c.text || "").trim(); });
      const iN = headersPrev.findIndex((h) => /nro|causa|exped/.test(norm(h)));
      for (let r = 2; r <= ws.rowCount; r++) {
        const o = {};
        headersPrev.forEach((h, i) => { if (h) o[h] = ws.getRow(r).getCell(i + 1).value; });
        const nro = str(ws.getRow(r).getCell((iN < 0 ? 0 : iN) + 1).value);
        if (nro) filas.set(keyClave(nro), o);
      }
    }
  }

  // Encabezado de salida: Orden + feed + calculadas + columnas del usuario + gestion faltante.
  // Las calculadas quedan SIEMPRE (aunque el archivo viejo no las tuviera); las de gestion se
  // preservan y se agregan las que falten. Se evita duplicar columnas ya conocidas.
  const conocidas = [...BOT_HEADERS, ...CALC_HEADERS];
  const prev = headersPrev.filter(Boolean).filter((h) => norm(h) !== "orden");
  const extras = prev.filter((h) => !conocidas.some((b) => norm(b) === norm(h)));
  const faltanGest = GESTION_HEADERS.filter((g) => !extras.some((e) => norm(e) === norm(g)));
  const faltanPlanilla = PLANILLA_HEADERS.filter((g) => !extras.some((e) => norm(e) === norm(g)));
  const headers = ["Orden", ...BOT_HEADERS, ...CALC_HEADERS, ...extras, ...faltanGest, ...faltanPlanilla];

  // Merge del feed.
  let nuevas = 0, actualizadas = 0;
  for (const [clave, g] of feed) {
    const k = keyClave(clave);
    if (filas.has(k)) {
      const o = filas.get(k);
      const pu = parseFechaAr(str(o[hUlt])); if (!pu || g.max > pu) o[hUlt] = fmtDia(g.max.getTime());
      const pp = parseFechaAr(str(o[hPri])); if (!pp || g.min < pp) o[hPri] = fmtDia(g.min.getTime());
      if (!str(o[hCar])) o[hCar] = g.caratula;
      if (!str(o[hFue])) o[hFue] = g.fuero;
      actualizadas++;
    } else {
      filas.set(k, { [hNro]: g.clave, [hCar]: g.caratula, [hFue]: g.fuero, [hPri]: fmtDia(g.min.getTime()), [hUlt]: fmtDia(g.max.getTime()), [hEst]: "Activa" });
      nuevas++;
    }
  }

  // Ordenar por fuero, luego por numero de expediente.
  const lista = [...filas.values()].sort((a, b) => {
    const fa = str(a[hFue]), fb = str(b[hFue]);
    if (fa !== fb) return fa.localeCompare(fb);
    return str(a[hNro]).localeCompare(str(b[hNro]), undefined, { numeric: true });
  });

  // Reescribir con Orden 1..n.
  const wb2 = new ExcelJS.Workbook();
  const ws2 = wb2.addWorksheet("CAUSAS");
  ws2.addRow(headers);
  ws2.getRow(1).font = { bold: true };
  lista.forEach((o, idx2) => {
    ws2.addRow(headers.map((h) => {
      if (h === "Orden") return idx2 + 1;
      const v = o[h];
      return (v && typeof v === "object" && v.result !== undefined) ? v.result : (v ?? null);
    }));
  });
  await wb2.xlsx.writeFile(p);
  return { nuevas, actualizadas, total: lista.length, archivo: p };
}

// ─── volcado de plazos calculados a la cartera ────────────────────────────────
// Escribe en cada fila el resultado del computo de caducidad y prescripcion (fecha de
// vencimiento, dias restantes, alerta). Se llama DESPUES de calcularCaducidad/calcularPenal,
// con los arrays "todas" (no solo las en riesgo), para que TODA causa muestre su plazo.
// Recibe: { caducidad: [{nro,venc,restan,nivel,impulsoVerificado,tipoProceso}],
//           prescripcion: [{nro,prescribe,restan,nivel}] }. Preserva el resto del archivo.
const fmtDiaD = (d) => d instanceof Date && !isNaN(d) ? new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric" }).format(d) : "";
function alertaCaduc(it) {
  if (it.tipoProceso) return "VERIFICAR APLICABILIDAD";
  if (!it.impulsoVerificado) return "REVISION (impulso estimado)";
  return { vencido: "VENCIDO", urgente: "URGENTE", preventivo: "preventivo", lejano: "en termino" }[it.nivel] || it.nivel;
}
const alertaPrescr = (it) => ({ prescripta: "PRESCRIPTA?", urgente: "URGENTE", preventivo: "preventivo", lejano: "en termino" }[it.nivel] || it.nivel);

export async function volcarCalculos({ caducidad = [], prescripcion = [] } = {}) {
  let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch { return { nota: "falta exceljs" }; }
  const p = carteraPath();
  if (!fs.existsSync(p)) return { nota: "sin cartera-pjn.xlsx" };
  const str = (v) => v == null ? "" : (typeof v === "object" ? (v.result ?? v.text ?? "") : v).toString().trim();
  const keyClave = (s) => str(s).toUpperCase().replace(/\s+/g, " ");

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  const ws = wb.worksheets[0];
  if (!ws) return { nota: "sin hoja" };

  // Header actual.
  const headers = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { headers[i - 1] = String(c.text || "").trim(); });
  const iNro = headers.findIndex((h) => /nro|causa|exped/.test(norm(h)) && !norm(h).includes("caratula"));
  if (iNro < 0) return { nota: "cartera sin columna Nro. Causa" };

  // Asegurar que existan las columnas calculadas (agregar al header las que falten).
  for (const h of CALC_HEADERS) if (!headers.some((x) => norm(x) === norm(h))) { headers.push(h); ws.getRow(1).getCell(headers.length).value = h; }
  ws.getRow(1).font = { bold: true };
  const colIdx = (name) => headers.findIndex((h) => norm(h) === norm(name)) + 1;
  const cCadV = colIdx("Caduc. Vence"), cCadD = colIdx("Caduc. Dias"), cCadA = colIdx("Caduc. Alerta");
  const cPreV = colIdx("Prescr. Vence"), cPreD = colIdx("Prescr. Dias"), cPreA = colIdx("Prescr. Alerta");
  const cAct = colIdx("Plazos Actualizado");

  const mCad = new Map(); for (const it of caducidad) mCad.set(keyClave(it.nro), it);
  const mPre = new Map(); for (const it of prescripcion) mPre.set(keyClave(it.nro), it);
  const hoyTxt = fmtDiaD(new Date());

  let escritas = 0;
  for (let r = 2; r <= ws.rowCount; r++) {
    const nro = keyClave(ws.getRow(r).getCell(iNro + 1).value);
    if (!nro) continue;
    const cad = mCad.get(nro), pre = mPre.get(nro);
    const row = ws.getRow(r);
    // Caducidad: si la causa tiene computo se escribe; si no (penal/laboral/cerrada) se limpia.
    row.getCell(cCadV).value = cad ? fmtDiaD(cad.venc) : "";
    row.getCell(cCadD).value = cad ? cad.restan : "";
    row.getCell(cCadA).value = cad ? alertaCaduc(cad) : "";
    // Prescripcion: con computo -> fecha/dias/alerta; sin datos suficientes -> nota de que falta.
    row.getCell(cPreV).value = (pre && !pre.faltaDato) ? fmtDiaD(pre.prescribe) : "";
    row.getCell(cPreD).value = (pre && !pre.faltaDato) ? pre.restan : "";
    row.getCell(cPreA).value = pre ? (pre.faltaDato ? pre.motivo : alertaPrescr(pre)) : "";
    row.getCell(cAct).value = (cad || pre) ? hoyTxt : "";
    if (cad || pre) escritas++;
  }
  await wb.xlsx.writeFile(p);
  return { escritas, archivo: p };
}

// ─── cruce con la planilla "LISTADO JUICIOS" ──────────────────────────────────
// Extrae { fuero, numero, anio2 } de un "Nro. Causa" tal como lo arma agruparFeed
// (clave del feed, ej. "CIV 016915/2025"). anio2 = ultimos 2 digitos, para poder
// comparar años de 2 o 4 digitos sin ambiguedad.
export function extraerFueroNumAnio(nroCausaTxt) {
  const s = String(nroCausaTxt || "").toUpperCase();
  const mNum = s.match(/(\d{1,7})\s*\/\s*(\d{2,4})/);
  if (!mNum) return null;
  const mFuero = s.match(/^([A-Z]{2,4})\b/);
  const anioRaw = mNum[2];
  return { fuero: mFuero ? mFuero[1] : "", numero: String(Number(mNum[1])), anio2: anioRaw.length >= 4 ? anioRaw.slice(-2) : anioRaw.padStart(2, "0") };
}
function anio2De(anio) { const s = String(anio || "").trim(); return s.length >= 4 ? s.slice(-2) : s.padStart(2, "0"); }

/**
 * Cruza la cartera con las filas PJN de la planilla (lib/planilla-causas.mjs):
 *  - completa Actor/Demandado/Materia/Firma SOLO en celdas vacias y marca "En Planilla"=SI
 *    en las filas de la cartera que matchean por fuero+numero+año (o numero+año si la
 *    planilla no trae fuero).
 *  - agrega como fila nueva las causas de la planilla que la cartera todavia no tiene
 *    (el feed nunca las trajo), sin inventar fechas de movimiento.
 *  - si una fila de la planilla podria matchear mas de una fila de la cartera, no toca
 *    ninguna: la reporta en "ambiguas" para que se revise a mano.
 * Devuelve { matcheadas, agregadas, ambiguas, archivo }.
 */
export async function aplicarPlanilla(filasPlanillaPjn) {
  let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch { return { nota: "falta exceljs" }; }
  const p = carteraPath();
  if (!fs.existsSync(p)) return { nota: "sin cartera-pjn.xlsx (correr sembrar-causas.mjs primero)" };
  if (!filasPlanillaPjn || !filasPlanillaPjn.length) return { matcheadas: 0, agregadas: 0, ambiguas: [], archivo: p };

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  const ws = wb.worksheets[0];
  if (!ws) return { nota: "sin hoja" };

  const headers = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { headers[i - 1] = String(c.text || "").trim(); });
  const iNro = headers.findIndex((h) => /nro|causa|exped/.test(norm(h)) && !norm(h).includes("caratula"));
  if (iNro < 0) return { nota: "cartera sin columna Nro. Causa" };
  for (const h of PLANILLA_HEADERS) if (!headers.some((x) => norm(x) === norm(h))) { headers.push(h); ws.getRow(1).getCell(headers.length).value = h; }
  ws.getRow(1).font = { bold: true };
  const ci = (name) => headers.findIndex((h) => norm(h) === norm(name)) + 1;
  const cAct = ci("Actor"), cDem = ci("Demandado"), cMat = ci("Materia"), cFir = ci("Firma"), cEnPl = ci("En Planilla");
  const cCar = ci("Caratula"), cFue = ci("Fuero");

  // Indice de filas de cartera por numero+anio2 (con y sin fuero), para detectar ambiguedad.
  const porNumAnio = new Map(); // "numero|anio2" -> [rowNum,...]
  const porFueroNumAnio = new Map(); // "fuero|numero|anio2" -> [rowNum,...]
  for (let r = 2; r <= ws.rowCount; r++) {
    const info = extraerFueroNumAnio(ws.getRow(r).getCell(iNro + 1).value);
    if (!info) continue;
    const kNA = `${info.numero}|${info.anio2}`;
    if (!porNumAnio.has(kNA)) porNumAnio.set(kNA, []);
    porNumAnio.get(kNA).push(r);
    if (info.fuero) {
      const kFNA = `${info.fuero}|${info.numero}|${info.anio2}`;
      if (!porFueroNumAnio.has(kFNA)) porFueroNumAnio.set(kFNA, []);
      porFueroNumAnio.get(kFNA).push(r);
    }
  }

  const strCell = (v) => v == null ? "" : (typeof v === "object" ? (v.result ?? v.text ?? "") : v).toString().trim();
  const setSiVacio = (row, col, v) => { if (col && v && !strCell(row.getCell(col).value)) row.getCell(col).value = v; };

  let matcheadas = 0, agregadas = 0;
  const ambiguas = [];
  const filasNuevas = [];
  for (const f of filasPlanillaPjn) {
    const numero = String(Number(f.numero));
    const anio2 = anio2De(f.anio);
    let candidatos = f.fuero ? (porFueroNumAnio.get(`${f.fuero}|${numero}|${anio2}`) || []) : [];
    if (!candidatos.length) candidatos = porNumAnio.get(`${numero}|${anio2}`) || [];
    if (candidatos.length > 1) { ambiguas.push({ fuero: f.fuero, numero: f.numero, anio: f.anio, filas: candidatos }); continue; }
    if (candidatos.length === 1) {
      const row = ws.getRow(candidatos[0]);
      setSiVacio(row, cAct, f.actor);
      setSiVacio(row, cDem, f.demandado);
      setSiVacio(row, cMat, f.materia);
      setSiVacio(row, cFir, f.firma);
      if (cEnPl) row.getCell(cEnPl).value = "SI";
      matcheadas++;
    } else {
      filasNuevas.push(f);
    }
  }

  for (const f of filasNuevas) {
    const nroCausa = `${f.fuero ? f.fuero + " " : ""}${f.numero}/${f.anio}`;
    const caratula = f.actor && f.demandado ? `${f.actor} C/ ${f.demandado}${f.materia ? " S/ " + f.materia : ""}` : "";
    const row = ws.getRow(ws.rowCount + 1);
    if (iNro >= 0) row.getCell(iNro + 1).value = nroCausa;
    if (cCar) row.getCell(cCar).value = caratula;
    if (cFue && f.fuero) row.getCell(cFue).value = fueroDe(f.fuero);
    if (cAct) row.getCell(cAct).value = f.actor;
    if (cDem) row.getCell(cDem).value = f.demandado;
    if (cMat) row.getCell(cMat).value = f.materia;
    if (cFir) row.getCell(cFir).value = f.firma;
    if (cEnPl) row.getCell(cEnPl).value = "SI";
    const cObs = ci("Observaciones");
    if (cObs) row.getCell(cObs).value = "Agregada desde planilla (sin datos de movimientos; correr sembrar-causas.mjs con mas SEED_MESES si no aparece sola)";
    agregadas++;
  }

  await wb.xlsx.writeFile(p);
  return { matcheadas, agregadas, ambiguas, archivo: p };
}

// ─── lectura para sync-supabase.mjs ───────────────────────────────────────────
/**
 * Filas de la cartera en formato listo para lib/sync-supabase.mjs: [{
 *   numero, fuero, anio2, caratula, actor, demandado, materia, firma
 * }]. Se llama DESPUES de aplicarPlanilla (para que Actor/Demandado/Materia/Firma
 * ya esten completos). No incluye "inc" (viene de la planilla, se cruza aparte).
 */
export async function filasParaSync() {
  let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch { return []; }
  const p = carteraPath();
  if (!fs.existsSync(p)) return [];
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(p);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const headers = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { headers[i - 1] = String(c.text || "").trim(); });
  const iNro = headers.findIndex((h) => /nro|causa|exped/.test(norm(h)) && !norm(h).includes("caratula"));
  const ci = (name) => headers.findIndex((h) => norm(h) === norm(name)) + 1;
  const cCar = ci("Caratula"), cAct = ci("Actor"), cDem = ci("Demandado"), cMat = ci("Materia"), cFir = ci("Firma");
  const strCell = (v) => v == null ? "" : (typeof v === "object" ? (v.result ?? v.text ?? "") : v).toString().trim();
  if (iNro < 0) return [];
  const out = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const info = extraerFueroNumAnio(ws.getRow(r).getCell(iNro + 1).value);
    if (!info) continue;
    out.push({
      numero: info.numero, fuero: info.fuero, anio2: info.anio2,
      caratula: cCar ? strCell(ws.getRow(r).getCell(cCar).value) : "",
      actor: cAct ? strCell(ws.getRow(r).getCell(cAct).value) : "",
      demandado: cDem ? strCell(ws.getRow(r).getCell(cDem).value) : "",
      materia: cMat ? strCell(ws.getRow(r).getCell(cMat).value) : "",
      firma: cFir ? strCell(ws.getRow(r).getCell(cFir).value) : "",
    });
  }
  return out;
}
