#!/usr/bin/env node
/**
 * parte-diario-pjn.mjs - Parte diario de novedades del Portal PJN por email.
 *
 * Script UNICO del frente PJN (consolidado jul-2026; antes convivian una v1 y
 * una "v2" separadas y era facil correr por error la version sin modulos).
 * Hace: login por navegador real (Puppeteer + perfil persistente), captura del
 * Bearer, feed /eventos/ de api.pjn.gov.ar, agrupado por fuero, envio por Gmail.
 * Ademas:
 *
 *   1) ALERTA DE FALLA CRITICA: si el script falla (portal caido, token, SMTP,
 *      etc.) manda un mail de aviso en vez de morir en silencio. Ademas escribe
 *      un archivo "ultima-corrida.log" en cada corrida exitosa (heartbeat), para
 *      poder auditar cuando fue la ultima vez que efectivamente corrio.
 *   2) VENTANA POR DIAS HABILES: en vez de una ventana fija de N dias, calcula el
 *      corte hasta el ultimo dia habil (contempla fin de semana y feriados). Un
 *      lunes a la tarde toma tambien lo publicado el viernes. Se puede volver al
 *      modo fijo con MODO_VENTANA=fijo.
 *   3) VALIDACION DE DESCARGA: cada PDF se valida (tamano minimo + firma %PDF) y
 *      se reintenta una vez. Las descargas que fallan se reportan en el parte.
 *   4) PRIORIDAD DE CEDULAS: detecta actuaciones sensibles (traslado, intimacion,
 *      apercibimiento, suspension/reanudacion de plazos, sentencia, caducidad,
 *      audiencia, etc.) y las destaca en un bloque PRIORITARIAS al inicio.
 *   5) MODULOS DE GESTION: engancha lib/cartera.mjs (cartera-pjn.xlsx),
 *      lib/caducidad.mjs (caducidad de instancia CPCCN) y lib/penal.mjs
 *      (inactividad + prescripcion penal), mas los logs CSV de movimientos y causas.
 *
 * No agrega dependencias fuera de puppeteer + nodemailer (+ exceljs opcional
 * para la cartera).
 *
 * Config: copiar .env.example a .env y completar. El .env NO se commitea.
 * Uso manual (prueba):  node parte-diario-pjn.mjs
 *
 * NOTA: verificar siempre en el Portal PJN antes de computar plazos. La firma es
 * del abogado. Este parte es una ayuda de seguimiento, no una notificacion.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── .env minimal (sin dependencia extra) ────────────────────────────────────
(function cargarEnv() {
  const envPath = path.resolve(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const linea of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

const CFG = {
  pjnUser: process.env.PJN_USER || "",
  pjnPass: process.env.PJN_PASS || "",
  smtpHost: process.env.SMTP_HOST || "smtp.gmail.com",
  smtpPort: Number(process.env.SMTP_PORT || 465),
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  mailFrom: process.env.MAIL_FROM || process.env.SMTP_USER || "",
  mailTo: process.env.MAIL_TO || "",
  // Destinatario de las alertas de falla. Si no se define, usa MAIL_TO.
  mailToAlerta: process.env.MAIL_TO_ALERTA || process.env.MAIL_TO || "",
  dias: Number(process.env.DIAS || 1),
  modoVentana: (process.env.MODO_VENTANA || "habil").toLowerCase(), // habil | fijo
  feriados: (process.env.FERIADOS || "").split(",").map((s) => s.trim()).filter(Boolean),
  paginas: Number(process.env.PAGINAS || 5),
  // Dias hacia atras en los que se buscan eventos todavia NO reportados (por si una
  // corrida no se hizo o el portal publico tarde algo con fecha de firma anterior).
  lookbackDias: Number(process.env.LOOKBACK_DIAS || 10),
  profileDir: process.env.PROFILE_DIR || path.resolve(__dirname, ".pjn-profile"),
  headless: (process.env.HEADLESS || "true") !== "false",
  enviarSinNovedades: (process.env.ENVIAR_SIN_NOVEDADES || "true") !== "false",
  adjuntarPdfs: (process.env.ADJUNTAR_PDFS || "true") !== "false",
  maxPdfs: Number(process.env.MAX_PDFS || 25),
  guardarPdfs: (process.env.GUARDAR_PDFS_LOCAL || "true") !== "false",
  carpetaPdfs: process.env.CARPETA_PDFS || path.resolve(__dirname, "pdfs"),
  pdfMinBytes: Number(process.env.PDF_MIN_BYTES || 1000),
  alertaFalla: (process.env.ALERTA_FALLA || "true") !== "false",
  // Fallback local: donde se escribe ALERTA_CRITICA.txt si no se pudo mandar el
  // mail de falla (red/IP/SMTP caidos). Default: la propia carpeta del repo.
  // Sugerencia: apuntar al Escritorio.
  alertaLocalDir: process.env.ALERTA_LOCAL_DIR || __dirname,
};

// Feriados / dias inhabiles: se combinan los del .env (FERIADOS=...) con un
// feriados.json opcional en la carpeta del repo. Cada entrada puede ser:
//   - una fecha ISO suelta:   "2026-07-09"
//   - un RANGO inclusivo:     "2026-01-01..2026-01-31"  (para feria judicial/receso)
// El rango se expande a fechas individuales. Sirve para la feria de enero, el
// receso de invierno y paros de varios dias, sin listar cada fecha a mano.
function expandirFeriados(lista) {
  const out = new Set();
  const addRango = (a, b) => {
    let cur = new Date(a + "T00:00:00Z");
    const fin = new Date(b + "T00:00:00Z");
    let guarda = 0;
    while (cur <= fin && guarda++ < 400) {
      out.add(cur.toISOString().slice(0, 10));
      cur = new Date(cur.getTime() + 86400000);
    }
  };
  for (const raw of lista) {
    const s = String(raw).trim();
    const rango = s.match(/^(\d{4}-\d{2}-\d{2})\s*\.\.\s*(\d{4}-\d{2}-\d{2})$/);
    if (rango) { addRango(rango[1], rango[2]); continue; }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) out.add(s);
  }
  return out;
}
(function cargarFeriados() {
  let lista = [...CFG.feriados];
  const p = path.resolve(__dirname, "feriados.json");
  if (fs.existsSync(p)) {
    try {
      const arr = JSON.parse(fs.readFileSync(p, "utf8"));
      if (Array.isArray(arr)) lista.push(...arr.map((s) => String(s).trim()));
    } catch (e) {
      console.error("Aviso: feriados.json invalido, se ignora:", e.message);
    }
  }
  CFG.feriados = Array.from(expandirFeriados(lista));
})();

// Argentina no aplica horario de verano: offset fijo UTC-3.
const AR_OFFSET_HORAS = 3;

// Fecha de hoy en AR como YYYY-MM-DD, para la subcarpeta del dia.
function hoyAR() {
  const p = new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}

const API = "https://api.pjn.gov.ar";
const HOME_URL = "https://portalpjn.pjn.gov.ar/inicio";
const log = (...a) => console.log(new Date().toISOString(), ...a);

const fmtFecha = (ms) => !ms ? "s/f" : new Intl.DateTimeFormat("es-AR", {
  timeZone: "America/Argentina/Buenos_Aires",
  day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
}).format(new Date(ms));
const letra = (t) => t === "despacho" ? "D" : (t === "cedula" ? "N" : "?");

// Nombres de fuero por prefijo de la clave de expediente (CCC 7336/2021 -> CCC).
const FUEROS = {
  CIV: "Nac. Civil", COM: "Nac. Comercial", CNT: "Nac. del Trabajo",
  CSS: "Fed. Seguridad Social", CCC: "Nac. Criminal y Correccional",
  CFP: "Fed. Criminal y Correccional", CPE: "Nac. Penal Economico",
  CPF: "Fed. Casacion Penal", CPN: "Nac. Casacion Penal", CAF: "Fed. Cont. Adm.",
  CNE: "Nac. Electoral", CCF: "Fed. Civil y Comercial",
};
function fueroDe(clave) {
  const m = (clave || "").trim().match(/^([A-Z]{2,4})\b/);
  const cod = m ? m[1] : "OTROS";
  return { cod, nombre: FUEROS[cod] || cod };
}

// ─── ventana temporal por dias habiles ────────────────────────────────────────
// AR midnight de una fecha (Y-M-D) expresado en epoch ms. AR = UTC-3 fijo.
function arMidnightMs(y, m, d) {
  return Date.UTC(y, m - 1, d, AR_OFFSET_HORAS, 0, 0, 0);
}
// Recibe un Date que representa la medianoche AR (03:00 UTC) y dice si es habil.
function esFechaHabil(dMid, feriados) {
  const dow = dMid.getUTCDay(); // 0 dom, 6 sab
  if (dow === 0 || dow === 6) return false;
  const iso = dMid.toISOString().slice(0, 10);
  return !feriados.includes(iso);
}
// Calcula el corte (epoch ms) y una descripcion legible de la ventana.
function calcularCorte() {
  if (CFG.modoVentana === "fijo") {
    const corte = Date.now() - CFG.dias * 24 * 60 * 60 * 1000;
    return { corte, desc: `ultimos ${CFG.dias} dia(s) [modo fijo]` };
  }
  const [y, m, d] = hoyAR().split("-").map(Number);
  let cur = new Date(arMidnightMs(y, m, d)); // medianoche AR de hoy
  // Retroceder hasta el dia habil inmediato anterior.
  do {
    cur = new Date(cur.getTime() - 24 * 60 * 60 * 1000);
  } while (!esFechaHabil(cur, CFG.feriados));
  const corte = cur.getTime();
  const iso = cur.toISOString().slice(0, 10);
  const dias = Math.round((arMidnightMs(y, m, d) - corte) / 86400000);
  return { corte, desc: `desde el ultimo dia habil (${iso} 00:00 AR, ${dias} dia[s] atras) [modo habil]` };
}

// ─── prioridad de actuaciones ─────────────────────────────────────────────────
// Palabras que marcan una actuacion como sensible para el computo de plazos o la
// estrategia, en TODAS las ramas (no solo penal). La deteccion es orientativa: NO
// reemplaza la lectura del despacho. Ante la duda, se prioriza.
const RX_PRIORIDAD = new RegExp(
  "\\b(" + [
    // Comunes a todos los fueros (plazos / notificaciones / recursos)
    "traslad", "intim", "apercib", "caduc", "peren", "suspen", "reanud",
    "sentenc", "resuelv", "resolu", "hace lugar", "rechaz", "deniega", "desestim",
    "audiencia", "vista", "notif", "plazo", "vencimiento", "apel", "recurs",
    "queja", "nulidad", "revoc", "aclarator", "regulac", "honorar", "oficio",
    // Civil y comercial / procesal
    "demanda", "contest", "excepc", "prescrip", "prueb", "pericia", "aleg",
    "ejecut", "subast", "embarg", "inhib", "cautelar", "medida", "rebeld",
    "homologac", "mediacion", "conciliac", "desaloj",
    // Laboral / previsional
    "liquidac", "reajust", "haber", "retroactiv",
    // Familia
    "aliment", "tenenc", "cuota", "regimen de comunicac", "restituc",
    // Concursal / comercial
    "quiebra", "concurso", "verificac", "pronto pago",
    // Contencioso administrativo / tributario
    "multa", "astreinte", "sancion", "recurso jerarquic",
    // Penal
    "prision", "excarcel", "eximicion", "indagatoria", "procesamiento",
    "sobresei", "elevacion a juicio", "requerimiento", "condena", "absol",
  ].join("|") + ")\\w*", "i"
);
function textoEvento(it) {
  const p = it.payload || {};
  return [it.tipo, it.descripcion, it.titulo, it.detalle, it.sintesis,
    p.descripcion, p.detalle, p.titulo, p.tipoEvento, p.sintesis, p.caratulaExpediente]
    .filter(Boolean).join(" | ");
}
// Prioritario si matchea una palabra sensible o si es cedula (efecto notificatorio).
function esPrioritario(it) {
  if (it.tipo === "cedula") return true;
  return RX_PRIORIDAD.test(textoEvento(it));
}
function motivoPrioridad(it) {
  if (it.tipo === "cedula") return "cedula";
  const m = textoEvento(it).match(RX_PRIORIDAD);
  return m ? m[0].toLowerCase() : "";
}
// Heuristica de resolucion adversa/denegatoria. NO baja la prioridad (en penal, si
// hay duda se prioriza): solo agrega una etiqueta para ayudar a triar la lectura.
const RX_NEGATIVA = /\bno\s+(ha|hace)\s+lugar|\brechaz\w*|\bdeniega\w*|\bdesestim\w*|\bno\s+ha\s+lugar/i;
function marcaNegativa(it) {
  return RX_NEGATIVA.test(textoEvento(it));
}

// ─── 1) login + captura de token via navegador real ──────────────────────────
// Token cacheado: Chrome es lo que mas memoria usa (~300-400 MB). Si el token de la
// corrida anterior sigue vigente (claim "exp" del JWT con margen de 3 min), se reusa
// y no se abre Chrome. El archivo queda solo en el servidor (.gitignore).
// Cuentas del Portal PJN (nov-2026): la principal (PJN_USER) y, opcional, una segunda
// (PJN_USER_2 / PJN_PASS_2 / PJN_NOMBRE_2) para ver las notificaciones de las causas que
// firma otro letrado del estudio. Cada cuenta usa su propio perfil de Chrome y su token.
const CUENTAS = [
  { nombre: process.env.PJN_NOMBRE || "Soledad", user: CFG.pjnUser, pass: CFG.pjnPass, profileDir: CFG.profileDir, cache: path.resolve(__dirname, ".pjn-token.json"), principal: true },
  ...(process.env.PJN_USER_2 ? [{ nombre: process.env.PJN_NOMBRE_2 || "Sebastian", user: process.env.PJN_USER_2, pass: process.env.PJN_PASS_2 || "", profileDir: path.resolve(__dirname, ".pjn-profile-2"), cache: path.resolve(__dirname, ".pjn-token-2.json"), principal: false }] : []),
];
function expDeJwt(t) {
  try { return JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString("utf8")).exp * 1000 || 0; } catch { return 0; }
}
async function obtenerToken(cuenta = CUENTAS[0]) {
  try {
    const c = JSON.parse(fs.readFileSync(cuenta.cache, "utf8"));
    const exp = expDeJwt(c.token);
    if (exp - Date.now() > 3 * 60000) {
      const r = await fetch(`${API}/eventos/?page=0&pageSize=1&categoria=judicial`, { headers: { Authorization: `Bearer ${c.token}` } });
      if (r.ok) { log(`Token reusado (vence ${new Date(exp).toISOString()}): sin abrir Chrome.`); return c.token; }
    }
  } catch { /* sin cache o invalido */ }
  const token = await obtenerTokenChrome(cuenta);
  try {
    fs.writeFileSync(cuenta.cache, JSON.stringify({ token, guardado: new Date().toISOString() }), { mode: 0o600 });
    const exp = expDeJwt(token);
    if (exp) log(`Token nuevo: dura ${Math.round((exp - Date.now()) / 60000)} min.`);
  } catch {}
  return token;
}

async function obtenerTokenChrome(cuenta = CUENTAS[0]) {
  fs.mkdirSync(cuenta.profileDir, { recursive: true });
  const browser = await puppeteer.launch({
    headless: CFG.headless ? "new" : false,
    userDataDir: cuenta.profileDir,
    // Flags para maquina chica (1 GB): sin GPU, sin /dev/shm (usa /tmp), sin
    // extensiones ni procesos extra, y tope de memoria al V8 de las paginas.
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
      "--disable-extensions", "--disable-background-networking", "--disable-default-apps",
      "--disable-sync", "--no-first-run", "--mute-audio", "--renderer-process-limit=1",
      "--disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints",
      "--js-flags=--max-old-space-size=192"],
  });
  try {
    const page = (await browser.pages())[0] || (await browser.newPage());
    // No bajar imagenes, fuentes, estilos ni media: solo hace falta que la app pida
    // el token a la API. Ahorra memoria y tiempo (y baja los Timeout).
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const tipo = req.resourceType();
      if (tipo === "image" || tipo === "font" || tipo === "media" || tipo === "stylesheet") req.abort().catch(() => {});
      else req.continue().catch(() => {});
    });
    let token = null;
    page.on("request", (req) => {
      const a = req.headers()["authorization"] || req.headers()["Authorization"];
      if (a && /^Bearer .{20,}/.test(a)) token = a.slice(7);
    });

    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    for (let i = 0; i < 15 && !token; i++) await sleep(1000);

    if (!token && page.url().includes("sso.pjn.gov.ar")) {
      if (!cuenta.user || !cuenta.pass) throw new Error(`Sesion caducada y faltan usuario/clave de la cuenta ${cuenta.nombre} en .env para re-loguear.`);
      log("Sesion caducada: completando login del SSO con credenciales del .env");
      await page.waitForSelector("#username", { timeout: 20000 });
      await page.type("#username", cuenta.user, { delay: 15 });
      await page.type("#password", cuenta.pass, { delay: 15 });
      await Promise.all([
        page.click("#kc-login").catch(() => page.keyboard.press("Enter")),
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {}),
      ]);
      for (let i = 0; i < 20 && !token; i++) await sleep(1000);
    }

    if (!token) throw new Error(`No se capturo el token (URL actual: ${page.url()}). Si pide 2FA/captcha o la clave cambio, revisar.`);
    return token;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── 2) feed de eventos ───────────────────────────────────────────────────────
async function traerEventos(token) {
  const items = [];
  let fechaHasta = null;
  for (let p = 0; p < CFG.paginas; p++) {
    let ruta = `${API}/eventos/?page=${p}&pageSize=20&categoria=judicial`;
    if (fechaHasta) ruta += `&fechaHasta=${fechaHasta}`;
    const r = await fetch(ruta, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json, */*" } });
    if (!r.ok) throw new Error(`API /eventos/ HTTP ${r.status} en page ${p}`);
    const j = await r.json();
    const lote = j.items || [];
    if (p === 0 && lote.length) fechaHasta = lote[0].fechaCreacion;
    items.push(...lote);
    if (lote.length < 20) break;
  }
  return items;
}

// ─── 3) descargar PDFs de las novedades (con validacion + reintento) ──────────
async function bajarUnPdf(token, id) {
  for (let intento = 1; intento <= 2; intento++) {
    try {
      const r = await fetch(`${API}/eventos/${id}/pdf`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/pdf, */*" } });
      if (!r.ok) {
        if (intento === 2) return { ok: false, motivo: `HTTP ${r.status}` };
        await sleep(1500); continue;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      const esPdf = buf.length >= 5 && buf.slice(0, 5).toString("latin1") === "%PDF-";
      if (buf.length < CFG.pdfMinBytes || !esPdf) {
        if (intento === 2) return { ok: false, motivo: `archivo invalido (${buf.length} bytes, firmaPDF=${esPdf})` };
        await sleep(1500); continue;
      }
      return { ok: true, buf };
    } catch (e) {
      if (intento === 2) return { ok: false, motivo: e.message };
      await sleep(1500);
    }
  }
  return { ok: false, motivo: "sin resultado" };
}

// Busca fecha/hora de audiencia en el texto del PDF (best-effort; ver lib/agenda-
// audiencias.mjs). Solo se llama para PDFs de novedades que ya matchearon "audiencia"
// o "vista de causa" en el titulo/descripcion, asi que el costo (parsear el PDF) es
// bajo. Si pdf-parse no esta instalado o el PDF no se puede leer, no corta el parte.
async function detectarAudiencia(buf) {
  let PDFParse; try { ({ PDFParse } = await import("pdf-parse")); } catch { return { nota: "falta pdf-parse (npm i pdf-parse)" }; }
  try {
    const { extraerAudiencia } = await import("./lib/agenda-audiencias.mjs");
    const parser = new PDFParse({ data: buf });
    const { text } = await parser.getText();
    return extraerAudiencia(text);
  } catch (e) {
    return { nota: `no se pudo leer el PDF: ${e.message}` };
  }
}

async function descargarPdfs(token, nuevos) {
  const fallos = [];    // { id, clave, motivo }
  const guardados = []; // { claveOriginal, path } - ruta local por PDF, para el Excel
  const agenda = [];    // { it, clave, audiencia } - audiencias detectadas en los PDFs
  if (!CFG.adjuntarPdfs && !CFG.guardarPdfs) return { adjuntos: [], fallos, guardados, agenda };
  const conDoc = nuevos.filter((it) => it.hasDocument).slice(0, CFG.maxPdfs);
  const adjuntos = [];

  let dir = null;
  if (CFG.guardarPdfs && conDoc.length) {
    dir = path.join(CFG.carpetaPdfs, hoyAR());
    fs.mkdirSync(dir, { recursive: true });
  }

  for (const it of conDoc) {
    const claveOriginal = it.payload?.claveExpediente || "";
    const clave = (claveOriginal || "exp").replace(/[^\w.-]+/g, "_");
    const res = await bajarUnPdf(token, it.id);
    if (!res.ok) {
      log(`PDF evento ${it.id} (${clave}): FALLO - ${res.motivo}`);
      fallos.push({ id: it.id, clave, motivo: res.motivo });
      continue;
    }
    const filename = `${clave}_${letra(it.tipo)}_${it.id}.pdf`;
    if (dir) {
      const full = path.join(dir, filename);
      fs.writeFileSync(full, res.buf);
      guardados.push({ claveOriginal, id: it.id, path: full });
    }
    if (CFG.adjuntarPdfs) adjuntos.push({ filename, content: res.buf });

    if (/audiencia|vista de causa/i.test(textoEvento(it))) {
      const r = await detectarAudiencia(res.buf);
      if (r && r.nota) log(`Audiencia (evento ${it.id}): ${r.nota}`);
      else if (r) agenda.push({ it, clave: claveOriginal, audiencia: r });
    }
  }

  if (dir) log(`PDFs guardados en: ${dir}`);
  if (CFG.adjuntarPdfs) log(`PDFs adjuntados al mail: ${adjuntos.length}`);
  if (fallos.length) log(`PDFs con problema de descarga: ${fallos.length}`);
  if (agenda.length) log(`Audiencias detectadas: ${agenda.length}`);
  return { adjuntos, fallos, guardados, agenda };
}

// ─── 4) armar el parte (bloque prioritarias + agrupado por fuero) ─────────────
function armarParte(nuevos, ventanaDesc, fallos, caducidad, penal, agenda = []) {
  const prioritarias = nuevos.filter(esPrioritario);

  const porFuero = new Map();
  for (const it of nuevos) {
    const pl = it.payload || {};
    const clave = pl.claveExpediente || "s/clave";
    const f = fueroDe(clave);
    if (!porFuero.has(f.cod)) porFuero.set(f.cod, { nombre: f.nombre, exps: new Map() });
    const exps = porFuero.get(f.cod).exps;
    if (!exps.has(clave)) exps.set(clave, { caratula: pl.caratulaExpediente || "", eventos: [] });
    exps.get(clave).eventos.push(it);
  }

  const fechaHoy = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "full" }).format(new Date());
  let texto = `Parte diario Portal PJN - ${fechaHoy}\nVentana: ${ventanaDesc}. ${nuevos.length} evento(s) en ${porFuero.size} fuero(s).\n\n`;
  let html = `<h2>Parte diario Portal PJN</h2><p><b>${fechaHoy}</b><br>Ventana: ${ventanaDesc}. ${nuevos.length} evento(s).</p>`;

  // Bloque PRIORITARIAS al inicio.
  if (prioritarias.length) {
    texto += `>>> PRIORITARIAS (${prioritarias.length}) - revisar primero <<<\n`;
    html += `<div style="border:2px solid #8b1e1e;border-radius:4px;padding:8px 10px;margin:10px 0"><b style="color:#8b1e1e">PRIORITARIAS (${prioritarias.length}) - revisar primero</b><ul style="margin:6px 0">`;
    for (const it of prioritarias) {
      const pl = it.payload || {};
      const clave = pl.claveExpediente || "s/clave";
      const mot = motivoPrioridad(it);
      const neg = marcaNegativa(it) ? " - posible resol. negativa/denegatoria" : "";
      texto += `  [!] ${clave} - ${pl.caratulaExpediente || ""} - [${letra(it.tipo)}] ${fmtFecha(it.fechaAccion)} (${mot}${neg})\n`;
      html += `<li><b>${clave}</b> - ${pl.caratulaExpediente || ""} - [${letra(it.tipo)}] ${fmtFecha(it.fechaAccion)} <span style="color:#8b1e1e">(${mot})</span>${neg ? `<span style="color:#b58900"> - posible resol. negativa</span>` : ""}</li>`;
    }
    texto += "\n"; html += "</ul></div>";
  }

  // Audiencias detectadas en los PDFs (best-effort; ver lib/agenda-audiencias.mjs).
  // Se adjunta un .ics por cada una (armado en main), para agendar con un clic.
  if (agenda.length) {
    const fmtFechaHora = (a) => {
      const f = new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(a.audiencia.fecha);
      const h = a.audiencia.hora ? ` ${String(a.audiencia.hora.hh).padStart(2, "0")}:${String(a.audiencia.hora.mm).padStart(2, "0")} hs` : " (sin hora detectada)";
      return f + h;
    };
    texto += `>>> AUDIENCIAS DETECTADAS (${agenda.length}) - VERIFICAR y agendar (.ics adjunto) <<<\n`;
    html += `<div style="border:2px solid #1e6b3a;border-radius:4px;padding:8px 10px;margin:10px 0"><b style="color:#1e6b3a">AUDIENCIAS DETECTADAS (${agenda.length}) - verificar y agendar (.ics adjunto)</b><ul style="margin:6px 0">`;
    for (const a of agenda) {
      const pl = a.it.payload || {};
      texto += `  [AGENDA] ${a.clave} - ${pl.caratulaExpediente || ""} - ${fmtFechaHora(a)} (confianza: ${a.audiencia.confianza})\n      contexto: "${a.audiencia.contexto}"\n`;
      html += `<li><b>${a.clave}</b> - ${pl.caratulaExpediente || ""} - ${fmtFechaHora(a)} <i>(confianza: ${a.audiencia.confianza})</i><br><span style="color:#555;font-size:12px">"${a.audiencia.contexto}"</span></li>`;
    }
    texto += "\n"; html += "</ul></div>";
  }

  // Alerta de caducidad de instancia (viene precalculada desde main).
  if (caducidad && caducidad.texto) {
    texto += caducidad.texto + "\n";
    html += caducidad.html;
  }

  // Frente penal: inactividad + prescripcion (viene precalculado desde main).
  if (penal && penal.texto) {
    texto += penal.texto + "\n";
    html += penal.html;
  }

  // Reporte de descargas fallidas (auditoria).
  if (fallos && fallos.length) {
    texto += `>>> DESCARGAS CON PROBLEMA (${fallos.length}) - bajar a mano del Portal <<<\n`;
    for (const f of fallos) texto += `  [x] ${f.clave} - evento ${f.id}: ${f.motivo}\n`;
    texto += "\n";
    html += `<div style="border:1px solid #b58900;border-radius:4px;padding:6px 10px;margin:10px 0;background:#fdf6e3"><b style="color:#b58900">Descargas con problema (${fallos.length})</b> - bajar a mano del Portal<ul style="margin:6px 0">`;
    for (const f of fallos) html += `<li>${f.clave} - evento ${f.id}: ${f.motivo}</li>`;
    html += "</ul></div>";
  }

  for (const [cod, { nombre, exps }] of porFuero) {
    texto += `################  ${nombre} (${cod})  ################\n\n`;
    html += `<h2 style="background:#8b1e1e;color:#fff;padding:4px 8px;margin:16px 0 6px;border-radius:3px">${nombre} <span style="opacity:.7">(${cod})</span></h2>`;
    for (const [clave, { caratula, eventos }] of exps) {
      texto += `== ${clave} ==\n${caratula}\n`;
      html += `<h3 style="margin:12px 0 2px">${clave}</h3><div style="color:#555">${caratula}</div><ul>`;
      for (const it of eventos) {
        const prio = esPrioritario(it) ? " [PRIORITARIA]" : "";
        const pdf = it.hasDocument ? `  [PDF: evento ${it.id}]` : "";
        const cta = CUENTAS.length > 1 && it.__cuenta ? ` (cuenta ${it.__cuenta})` : "";
        texto += `  - [${letra(it.tipo)}] ${fmtFecha(it.fechaAccion)}${prio}${pdf}${cta}\n`;
        html += `<li>[<b>${letra(it.tipo)}</b>] ${fmtFecha(it.fechaAccion)}${prio ? ` <span style="color:#8b1e1e">[PRIORITARIA]</span>` : ""}${it.hasDocument ? ` &mdash; PDF adjunto` : ""}${cta ? ` <span style="color:#777">${cta}</span>` : ""}</li>`;
      }
      texto += "\n"; html += "</ul>";
    }
  }
  html += `<hr><p style="color:#888;font-size:12px">Generado automaticamente. La deteccion de PRIORITARIAS es orientativa y no reemplaza la lectura del despacho. Verificar en el Portal PJN antes de computar plazos. La firma es del abogado.</p>`;
  return { texto, html, fueros: porFuero.size, prioritarias: prioritarias.length, revisionCaducidad: (caducidad && caducidad.revision) || 0, aplicabilidadCaducidad: (caducidad && caducidad.aplicabilidad) || 0 };
}

// ─── 5) email ─────────────────────────────────────────────────────────────────
function crearTransport() {
  return nodemailer.createTransport({
    host: CFG.smtpHost, port: CFG.smtpPort, secure: CFG.smtpPort === 465,
    auth: { user: CFG.smtpUser, pass: CFG.smtpPass },
    connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 30000,
  });
}

async function enviar({ texto, html }, adjuntos, nuevos, fueros, prioritarias, revisionCaducidad = 0, aplicabilidadCaducidad = 0) {
  const t = crearTransport();
  const fechaCorta = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short" }).format(new Date());
  const prefijo = (revisionCaducidad ? `[REVISION CADUCIDAD x${revisionCaducidad}] ` : "") + (aplicabilidadCaducidad ? `[VERIFICAR APLICABILIDAD x${aplicabilidadCaducidad}] ` : "") + (prioritarias ? `[${prioritarias} PRIORITARIA(S)] ` : "");
  const asunto = `${prefijo}Parte PJN ${fechaCorta} - ${nuevos} novedad(es) / ${fueros} fuero(s)`;
  const { guardarSalida } = await import("./lib/salida-parte.mjs");
  if (guardarSalida("PJN", { asunto, prefijo, texto, html, adjuntos, novedades: nuevos, prioritarias, falla: "" })) {
    log("Modo combinado: parte PJN guardado para el mail unico (no se manda mail propio).");
    return;
  }
  log("Conectando al servidor de correo para enviar...");
  await t.sendMail({ from: CFG.mailFrom, to: CFG.mailTo, subject: asunto, text: texto, html, attachments: adjuntos });
  log(`Email enviado a ${CFG.mailTo} (${adjuntos.length} adjunto/s)`);
}

// Fallback local: si no se pudo mandar el mail de falla (red/IP/SMTP caidos), deja
// un rastro imposible de pasar por alto: archivo ALERTA_CRITICA.txt + beep de consola.
function alertaLocal(err, motivoMailFallo) {
  const fecha = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short" }).format(new Date());
  const contenido = [
    `ALERTA CRITICA - Parte diario Portal PJN`,
    `=========================================`,
    ``,
    `La corrida FALLO y ademas NO se pudo enviar el mail de aviso.`,
    `Revisar el Portal PJN A MANO hoy mismo. No asumir que no hay novedades.`,
    ``,
    `Fecha/hora: ${fecha}`,
    `Error de la corrida: ${err && err.message ? err.message : String(err)}`,
    `Motivo por el que no salio el mail: ${motivoMailFallo || "n/d"}`,
  ].join("\n");
  try {
    const dest = path.join(CFG.alertaLocalDir, "ALERTA_CRITICA.txt");
    fs.writeFileSync(dest, contenido + "\n");
    log(`Fallback local escrito en: ${dest}`);
  } catch (e3) {
    log(`Tampoco se pudo escribir el fallback local: ${e3.message}`);
  }
  // Beep de consola (suena si corre en una terminal visible; inocuo si no).
  try { for (let i = 0; i < 5; i++) process.stdout.write("\x07"); } catch {}
}

// Aviso de falla critica. Best-effort: si el propio SMTP es el que falla, cae al
// fallback local (archivo + beep) para no quedar en silencio total.
async function enviarAlertaFalla(err) {
  if (!CFG.alertaFalla) return;
  if (!CFG.smtpUser || !CFG.smtpPass || !CFG.mailToAlerta) {
    log("No se pudo mandar alerta de falla por mail: faltan datos SMTP/MAIL_TO_ALERTA. Uso fallback local.");
    alertaLocal(err, "faltan datos SMTP/MAIL_TO_ALERTA");
    return;
  }
  try {
    const t = crearTransport();
    const fecha = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short" }).format(new Date());
    const texto = [
      `El parte diario del Portal PJN NO se genero correctamente.`,
      ``,
      `Fecha/hora: ${fecha}`,
      `Error: ${err && err.message ? err.message : String(err)}`,
      ``,
      `Accion sugerida: entrar al Portal PJN a mano y revisar novedades del dia.`,
      `Posibles causas: portal caido, sesion caducada (relogueo), 2FA/captcha, o corte de red.`,
    ].join("\n");
    await t.sendMail({
      from: CFG.mailFrom, to: CFG.mailToAlerta,
      subject: `[FALLA] Parte PJN ${fecha} - la corrida NO se completo`,
      text: texto,
    });
    log(`Alerta de falla enviada a ${CFG.mailToAlerta}`);
  } catch (e2) {
    log(`No se pudo enviar la alerta de falla por mail: ${e2.message}. Uso fallback local.`);
    alertaLocal(err, `fallo el envio del mail: ${e2.message}`);
  }
}

// Heartbeat: deja registro de la ultima corrida exitosa.
function registrarCorrida(resumen) {
  try {
    const linea = `${new Date().toISOString()} | OK | ${resumen}\n`;
    fs.appendFileSync(path.resolve(__dirname, "ultima-corrida.log"), linea);
  } catch (e) {
    log(`No se pudo escribir el heartbeat: ${e.message}`);
  }
  // Limpiar una alerta local de una corrida anterior fallida, ya superada.
  try {
    const alerta = path.join(CFG.alertaLocalDir, "ALERTA_CRITICA.txt");
    if (fs.existsSync(alerta)) fs.unlinkSync(alerta);
  } catch {}
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function main() {
  for (const [k, v] of Object.entries({ SMTP_USER: CFG.smtpUser, SMTP_PASS: CFG.smtpPass, MAIL_TO: CFG.mailTo })) {
    if (!v) throw new Error(`Falta ${k} en .env`);
  }
  const tokens = new Map(); // nombre de cuenta -> token
  const clavesPorCuenta = new Map(); // nombre de cuenta -> Set("FUERO|numero|aa") de causas vistas en su feed
  const claveDe = (it) => { const m = String(it.payload?.claveExpediente || "").match(/^([A-Z]{2,4})\s+(\d+)\/(\d{2,4})/); return m ? `${m[1]}|${Number(m[2])}|${m[3].slice(-2)}` : null; };
  const avisosCuentas = [];
  const items = [];
  for (const cuenta of CUENTAS) {
    try {
      log(`Cuenta ${cuenta.nombre}: login/captura de token del Portal PJN`);
      const tk = await obtenerToken(cuenta);
      tokens.set(cuenta.nombre, tk);
      let lote = await traerEventos(tk);
      clavesPorCuenta.set(cuenta.nombre, new Set(lote.map(claveDe).filter(Boolean)));
      // Cuenta secundaria: ve TODAS las causas de ese letrado. Solo se toman las que
      // estan en la planilla LISTADO JUICIOS (las que lleva la usuaria). Si la planilla
      // no se puede leer, entra todo (mejor de mas que de menos). PJN_FILTRO_2=todo lo apaga.
      if (!cuenta.principal && (process.env.PJN_FILTRO_2 || "planilla") === "planilla") {
        try {
          const { obtenerPlanilla } = await import("./lib/planilla-causas.mjs");
          const pl = await obtenerPlanilla();
          const claves = new Set((pl.porSistema?.PJN || []).map((f) => `${f.fuero}|${Number(f.numero)}|${String(f.anio).slice(-2)}`));
          if (claves.size) {
            const antes = lote.length;
            lote = lote.filter((it) => {
              const m = String(it.payload?.claveExpediente || "").match(/^([A-Z]{2,4})\s+(\d+)\/(\d{2,4})/);
              return m && claves.has(`${m[1]}|${Number(m[2])}|${m[3].slice(-2)}`);
            });
            log(`Cuenta ${cuenta.nombre}: ${lote.length} de ${antes} evento(s) son de causas de la planilla.`);
          }
        } catch (e) { log(`Cuenta ${cuenta.nombre}: no se pudo filtrar por planilla (${e.message}); entra todo.`); }
      }
      let nuevosLote = 0;
      for (const it of lote) if (!items.some((x) => String(x.id) === String(it.id))) { it.__cuenta = cuenta.nombre; items.push(it); nuevosLote++; }
      log(`Cuenta ${cuenta.nombre}: ${lote.length} evento(s) tomados (${nuevosLote} no repetidos).`);
    } catch (e) {
      if (cuenta.principal) throw e; // sin la cuenta principal no hay parte
      log(`Cuenta ${cuenta.nombre}: FALLO - ${e.message}`);
      avisosCuentas.push({ clave: `CUENTA ${cuenta.nombre}`, id: "-", motivo: `no se pudo leer el portal con esta cuenta: ${e.message}` });
    }
    if (CUENTAS.length > 1) await sleep(3000); // liberar memoria de Chrome entre cuentas
  }
  const token = tokens.get(CUENTAS[0].nombre);

  // FIRMA vacia en la planilla (nov-2026): se completa segun la cuenta donde aparece la
  // causa (principal -> PJN_FIRMA, default SOLEDAD; segunda -> PJN_FIRMA_2, default
  // SEBASTIAN; si esta en las dos, la principal). Nunca pisa una firma ya cargada.
  if (CUENTAS.length > 1) {
    try {
      const { obtenerPlanilla } = await import("./lib/planilla-causas.mjs");
      const { escribirCambios } = await import("./lib/planilla-gestion.mjs");
      const pl = await obtenerPlanilla();
      const firmas = [process.env.PJN_FIRMA || "SOLEDAD", process.env.PJN_FIRMA_2 || "SEBASTIAN"];
      const hoyTxt = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short" }).format(new Date());
      const cambios = [];
      for (const f of pl.porSistema?.PJN || []) {
        if (f.firma || !f.filaHoja) continue;
        const k = `${f.fuero}|${Number(f.numero)}|${String(f.anio).slice(-2)}`;
        const i = CUENTAS.findIndex((c) => clavesPorCuenta.get(c.nombre)?.has(k));
        if (i < 0) continue;
        cambios.push({ hoja: f.hoja, fila: f.filaHoja, columna: "FIRMA", valor: firmas[i] || CUENTAS[i].nombre.toUpperCase(), tipo: "aplicado", nota: `Completado por el bot el ${hoyTxt}: la causa aparece en las notificaciones del Portal PJN de la cuenta de ${CUENTAS[i].nombre}.` });
      }
      if (cambios.length) {
        const r = await escribirCambios(cambios);
        log(`Planilla FIRMA: ${r.nota || `${r.hechos} completada(s)${r.errores.length ? `; errores: ${r.errores.join(" | ")}` : ""}`}`);
      }
    } catch (e) { log(`Planilla FIRMA omitida: ${e.message}`); }
  }

  const { corte, desc } = calcularCorte();
  log(`Ventana: ${desc} (corte ${new Date(corte).toISOString()})`);
  // FIX nov-2026: antes se filtraba solo por fechaAccion >= ultimo dia habil. Asi se
  // perdian (a) los eventos que el portal publica tarde con fecha de firma anterior y
  // (b) todo lo de los dias en que la corrida no se hizo (VPS caido). Ahora es novedad
  // todo evento que todavia NO se reporto (no figura en movimientos-pjn.csv) y que es
  // de los ultimos LOOKBACK_DIAS. Sin historial (CSV vacio) se usa la ventana de siempre.
  const { idsYaRegistrados } = await import("./lib/movimientos-log.mjs");
  const vistos = idsYaRegistrados();
  const lookbackMs = Date.now() - CFG.lookbackDias * 86400000;
  const fechaEv = (it) => Math.max(Number(it.fechaCreacion) || 0, Number(it.fechaAccion) || 0);
  const nuevos = vistos.size === 0
    ? items.filter((it) => fechaEv(it) >= corte)
    : items.filter((it) => !vistos.has(String(it.id)) && fechaEv(it) >= lookbackMs);
  const atrasados = nuevos.filter((it) => fechaEv(it) < corte).length;
  const descParte = vistos.size === 0 ? desc
    : `${desc}; + eventos no reportados de los ultimos ${CFG.lookbackDias} dias${atrasados ? ` (${atrasados} atrasado/s)` : ""}`;
  log(`Novedades: ${nuevos.length} (${atrasados} de dias anteriores no reportados). Feed: ${items.length} evento(s) leidos; ${vistos.size} ya registrados.`);

  if (nuevos.length === 0 && !CFG.enviarSinNovedades) {
    log("Sin novedades y ENVIAR_SIN_NOVEDADES=false: no se envia correo.");
    registrarCorrida("0 novedades, sin envio");
    return;
  }

  // PDFs: cada evento se baja con el token de la cuenta que lo vio.
  const adjuntos = [], fallos = [...avisosCuentas], guardados = [], agenda = [];
  for (const [nombre, tk] of tokens) {
    const r = await descargarPdfs(tk, nuevos.filter((it) => (it.__cuenta || CUENTAS[0].nombre) === nombre));
    adjuntos.push(...r.adjuntos); fallos.push(...r.fallos); guardados.push(...r.guardados); agenda.push(...r.agenda);
  }

  // .ics por cada audiencia detectada, para agendar con un clic (Google Calendar/
  // Outlook/Apple Calendar abren un .ics adjunto directo).
  if (agenda.length) {
    const { generarICS } = await import("./lib/agenda-audiencias.mjs");
    for (const a of agenda) {
      const pl = a.it.payload || {};
      const ics = generarICS({
        uid: `audiencia-${a.it.id}@monitor-judicial-ar`,
        titulo: `Audiencia - ${a.clave} - ${pl.caratulaExpediente || ""}`.slice(0, 200),
        descripcion: `${pl.caratulaExpediente || ""}\n\nDetectado automaticamente (confianza: ${a.audiencia.confianza}). VERIFICAR contra el PDF adjunto antes de confirmar.\n\n"${a.audiencia.contexto}"`,
        fecha: a.audiencia.fecha,
        hora: a.audiencia.hora,
      });
      adjuntos.push({ filename: `audiencia_${a.clave.replace(/[^\w.-]+/g, "_")}_${a.it.id}.ics`, content: ics, contentType: "text/calendar; charset=utf-8" });
    }
  }

  // Cartera autocompletada: el bot agrega/actualiza causas en cartera-pjn.xlsx,
  // conservando las columnas de gestion que carga el usuario.
  try {
    const { actualizarCartera } = await import("./lib/cartera.mjs");
    const rcar = await actualizarCartera({ nuevos });
    if (rcar.nota) log(`Cartera: ${rcar.nota}`);
    else log(`Cartera (xlsx): ${rcar.nuevas} nueva(s), ${rcar.total} en total.${rcar.archivo ? " Archivo: " + rcar.archivo : ""}`);
  } catch (e) {
    log(`Cartera omitida: ${e.message}`);
  }

  // Cruce con la planilla "LISTADO JUICIOS" (actor/demandado/materia/firma + causas que
  // la planilla conoce y el feed todavia no trajo). No requiere el portal: es un fetch
  // aparte a Google Sheets, asi que si falla no debe cortar el parte.
  try {
    const { obtenerPlanilla } = await import("./lib/planilla-causas.mjs");
    const { aplicarPlanilla } = await import("./lib/cartera.mjs");
    const planilla = await obtenerPlanilla();
    if (planilla.error) log(`Planilla: ${planilla.stale ? "usando cache anterior, " : ""}${planilla.error}`);
    const rp = await aplicarPlanilla(planilla.porSistema.PJN);
    if (!rp.nota && !rp.migrada) { const { completarMigracion } = await import("./lib/planilla-gestion.mjs"); await completarMigracion("PJN", rp.migrar, log); }
    if (rp.nota) log(`Planilla -> cartera: ${rp.nota}`);
    else {
      log(`Planilla -> cartera: ${rp.matcheadas} matcheada(s), ${rp.agregadas} agregada(s) desde la planilla.`);
      if (rp.ambiguas && rp.ambiguas.length) log(`Planilla -> cartera: ${rp.ambiguas.length} ambigua(s) (revisar a mano): ${rp.ambiguas.map((a) => `${a.fuero || "?"} ${a.numero}/${a.anio}`).join(", ")}`);
    }
  } catch (e) {
    log(`Cruce con planilla omitido: ${e.message}`);
  }

  // Sync a Supabase (tabla public.casos de dashboard-legal). Diseno conservador: ver
  // lib/sync-supabase.mjs. No-op si SUPABASE_URL/SUPABASE_SERVICE_KEY no estan en .env.
  try {
    const { configSupabase, sincronizarCasos } = await import("./lib/sync-supabase.mjs");
    if (configSupabase()) {
      const { filasParaSync, extraerFueroNumAnio } = await import("./lib/cartera.mjs");
      const { obtenerPlanilla } = await import("./lib/planilla-causas.mjs");
      const filas = await filasParaSync();

      // inc (causa principal vs incidente) sale de la planilla, no de la cartera.
      const planilla = await obtenerPlanilla();
      const incPorClave = new Map();
      for (const f of planilla.porSistema?.PJN || []) incPorClave.set(`${f.fuero}|${Number(f.numero)}|${anio2De(f.anio)}`, f.inc || "");
      function anio2De(a) { const s = String(a || "").trim(); return s.length >= 4 ? s.slice(-2) : s.padStart(2, "0"); }

      // Novedades/ultimaActuacion de HOY, agrupadas por causa (fuero|numero|anio2).
      const hoyPorClave = new Map();
      for (const it of nuevos) {
        const info = extraerFueroNumAnio(it.payload?.claveExpediente);
        if (!info) continue;
        const k = `${info.fuero}|${info.numero}|${info.anio2}`;
        const f = new Date(it.fechaAccion || it.fechaCreacion || Date.now());
        const fechaISO = f.toISOString().slice(0, 10);
        const descripcion = (it.payload?.tipoEvento || it.payload?.titulo || it.payload?.descripcion || letra(it.tipo) || "Novedad").toString().slice(0, 300);
        const relevancia = esPrioritario(it) ? (marcaNegativa(it) ? "critico" : "importante") : "informativo";
        if (!hoyPorClave.has(k)) hoyPorClave.set(k, { ultima: null, novedades: [] });
        const g = hoyPorClave.get(k);
        g.novedades.push({ fecha: fechaISO, descripcion, relevancia });
        if (!g.ultima || fechaISO >= g.ultima.fecha) g.ultima = { fecha: fechaISO, descripcion };
      }

      const causas = filas.map((f) => {
        const k = `${f.fuero}|${Number(f.numero)}|${f.anio2}`;
        const hoy = hoyPorClave.get(k);
        return {
          numero: f.numero, fuero: f.fuero, anio: `20${f.anio2}`, inc: incPorClave.has(k) ? incPorClave.get(k) : null,
          caratula: f.caratula, actor: f.actor, demandado: f.demandado, materia: f.materia, firma: f.firma,
          ultimaActuacion: hoy ? hoy.ultima : null, novedadesNuevas: hoy ? hoy.novedades : [],
        };
      });

      const rs = await sincronizarCasos({ sistema: "PJN", causas });
      if (rs.nota) log(`Sync Supabase: ${rs.nota}`);
      else {
        log(`Sync Supabase: ${rs.actualizados} actualizado(s), ${rs.creados} creado(s), ${rs.sinCambios} sin cambios.`);
        if (rs.ambiguos.length) log(`Sync Supabase: ${rs.ambiguos.length} ambiguo(s) (revisar a mano): ${rs.ambiguos.map((a) => `${a.numero}${a.inc ? "/inc" + a.inc : ""}`).join(", ")}`);
        if (rs.errores.length) log(`Sync Supabase: ${rs.errores.length} error(es): ${rs.errores.map((e) => `${e.numero}: ${e.error}`).join(" | ")}`);
      }
    }
  } catch (e) {
    log(`Sync a Supabase omitido: ${e.message}`);
  }

  // Alerta de caducidad de instancia (lee cartera-pjn.xlsx).
  let caducidadRender = null;
  let caducidadTodas = [], prescripcionTodas = [];
  {
    try {
      const { calcularCaducidad, renderCaducidad } = await import("./lib/caducidad.mjs");
      const cad = await calcularCaducidad();
      if (cad.nota) log(`Caducidad: ${cad.nota}`);
      if (cad.items.length) log(`Caducidad: ${cad.items.length} causa(s) en riesgo; ${cad.sinImpulso || 0} sin impulso verificado; ${cad.sinAplicabilidad || 0} sucesion/voluntaria a revisar`);
      caducidadTodas = cad.todas || [];
      caducidadRender = renderCaducidad(cad.items, cad.sinImpulso || 0, cad.sinAplicabilidad || 0);
    } catch (e) {
      log(`Caducidad omitida: ${e.message}`);
    }
  }

  // Frente penal: monitor de inactividad + prescripcion (lee cartera-pjn.xlsx).
  let penalRender = null;
  {
    try {
      const { calcularPenal, renderPenal } = await import("./lib/penal.mjs");
      const pen = await calcularPenal();
      if (pen.nota) log(`Penal: ${pen.nota}`);
      if (pen.inactividad.length || pen.prescripcion.length) log(`Penal: ${pen.prescripcion.length} prescripcion, ${pen.inactividad.length} inactividad`);
      if (pen.sinTabla && pen.sinTabla.length) log(`Penal: ${pen.sinTabla.length} causa(s) con articulo detectado sin dato de pena (revisar)`);
      if (pen.delito && pen.delito.detectadas) {
        if (pen.delito.error) log(`Penal: no se pudo volcar "Delito (art. CP)" (${pen.delito.detectadas} deteccion[es]): ${pen.delito.error}`);
        else if (pen.delito.salida) log(`Penal: "Delito (art. CP)" completado en ${pen.delito.detectadas} fila(s). Archivo: ${pen.delito.salida}`);
      }
      prescripcionTodas = pen.prescripcionTodas || [];
      penalRender = renderPenal(pen);
    } catch (e) {
      log(`Penal omitido: ${e.message}`);
    }
  }

  // Volcar los plazos calculados (caducidad + prescripcion) a la cartera, para que cada
  // causa muestre en su fila el vencimiento, los dias restantes y la alerta. Va despues de
  // los calculos (y de que penal haya volcado "Delito"), para no pisarse.
  try {
    const { volcarCalculos } = await import("./lib/cartera.mjs");
    const vc = await volcarCalculos({ caducidad: caducidadTodas, prescripcion: prescripcionTodas });
    if (vc.nota) log(`Plazos en cartera: ${vc.nota}`);
    else log(`Plazos volcados a la cartera: ${vc.escritas} fila(s) con computo.`);
  } catch (e) {
    log(`Volcado de plazos a la cartera omitido: ${e.message}`);
  }

  const parte = armarParte(nuevos, descParte, fallos, caducidadRender, penalRender, agenda);
  await enviar(parte, adjuntos, nuevos.length, parte.fueros, parte.prioritarias, parte.revisionCaducidad, parte.aplicabilidadCaducidad);
  registrarCorrida(`${nuevos.length} novedades, ${parte.prioritarias} prioritarias, ${adjuntos.length} PDFs, ${fallos.length} descargas fallidas`);

  // Registro de novedades en CSV aparte (Plan B seguro: NO reescribe el Excel maestro,
  // asi no se dana el formato condicional ni los graficos). Va DESPUES del mail.
  try {
    const { registrarMovimientos } = await import("./lib/movimientos-log.mjs");
    const rc = await registrarMovimientos({ nuevos, guardados, esPrioritario });
    log(`Log MOVIMIENTOS (CSV): ${rc.agregadas} nueva(s), ${rc.duplicadas} ya cargada(s).${rc.archivo ? " Archivo: " + rc.archivo : ""}`);
  } catch (e) {
    log(`Log CSV de movimientos omitido: ${e.message}`);
  }

  // Lista de causas autogenerada desde el feed (numero, caratula, fuero, ult. mov.).
  try {
    const { registrarCausas } = await import("./lib/causas-log.mjs");
    const rl = await registrarCausas({ nuevos });
    log(`Lista de causas (CSV): ${rl.nuevas} nueva(s), ${rl.total} en total.${rl.archivo ? " Archivo: " + rl.archivo : ""}`);
  } catch (e) {
    log(`Lista de causas omitida: ${e.message}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error("ERROR:", e.message);
    await enviarAlertaFalla(e);
    process.exit(1);
  });
