#!/usr/bin/env node
/**
 * agenda-audiencias-semanal.mjs - Arma la agenda de audiencias de la semana que
 * viene (lunes a viernes) leyendo el calendario "AUDIENCIAS" de Google Calendar,
 * la vuelca a agenda-audiencias.xlsx (una hoja nueva por semana) y manda un mail
 * resumen. SIN IA: todo por reglas fijas, mismo glosario y prioridades que el
 * flujo manual que reemplaza (ver lib/agenda-reglas.mjs).
 *
 * Fuente: la "Direccion secreta en formato iCal" del calendario (Configuracion del
 * calendario > Integrar calendario). Es una URL con token: la lee cualquier cliente
 * HTTP, sin login ni OAuth (ver lib/ical-audiencias.mjs).
 *
 * Limitacion conocida: un evento tipo "TRES MEDIACIONES CABA" con varios horarios
 * en la descripcion queda como UNA fila (no se parte en 3): el detalle de horarios/
 * nombres queda en Notas, pero no se puede asignar por separado sin leerlo a mano.
 *
 * Config: comparte .env con los partes PJN/EJE/MEV (SMTP) + variables propias:
 *   ICAL_AUDIENCIAS_URL=https://calendar.google.com/calendar/ical/.../private-XXXX/basic.ics
 *   MAIL_TO_AGENDA=  (opcional; si no, cae en MAIL_TO)
 *   AGENDA_XLSX=     (opcional; default <repo>/agenda-audiencias.xlsx)
 *
 * Uso manual (prueba):  node agenda-audiencias-semanal.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import { obtenerEventos } from "./lib/ical-audiencias.mjs";
import { clasificar, marcarChoques } from "./lib/agenda-reglas.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  smtpHost: process.env.SMTP_HOST || "smtp.gmail.com",
  smtpPort: Number(process.env.SMTP_PORT || 465),
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  mailFrom: process.env.MAIL_FROM || process.env.SMTP_USER || "",
  mailTo: process.env.MAIL_TO_AGENDA || process.env.MAIL_TO || "",
  mailToAlerta: process.env.MAIL_TO_ALERTA || process.env.MAIL_TO_AGENDA || process.env.MAIL_TO || "",
  alertaFalla: (process.env.ALERTA_FALLA || "true") !== "false",
  alertaLocalDir: process.env.ALERTA_LOCAL_DIR || __dirname,
  icalUrl: process.env.ICAL_AUDIENCIAS_URL || "",
  xlsxPath: process.env.AGENDA_XLSX || path.resolve(__dirname, "agenda-audiencias.xlsx"),
};

function log(...a) { console.log(new Date().toISOString(), ...a); }

// ─── semana objetivo: proximo lunes a viernes (hora de Argentina) ────────────
function proximaSemana() {
  const ahoraAR = new Date(Date.now() - 3 * 3600000);
  const diaSemana = ahoraAR.getUTCDay(); // 0=domingo..6=sabado
  let diasHastaLunes = (8 - diaSemana) % 7;
  if (diasHastaLunes === 0) diasHastaLunes = 7; // si hoy es lunes, la semana QUE VIENE es la siguiente
  const lunesAR = new Date(Date.UTC(ahoraAR.getUTCFullYear(), ahoraAR.getUTCMonth(), ahoraAR.getUTCDate() + diasHastaLunes));
  const lunes = new Date(lunesAR.getTime() + 3 * 3600000); // volver a UTC real (medianoche AR)
  const finViernes = new Date(lunes.getTime() + 5 * 86400000); // sabado 00:00 AR = corte exclusivo
  return { desde: lunes, hasta: finViernes };
}

const MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
function nombreSemana(desde, hastaExclusivo) {
  const viernes = new Date(hastaExclusivo.getTime() - 86400000 - 3 * 3600000);
  const l = new Date(desde.getTime() - 3 * 3600000);
  const p = (n) => String(n).padStart(2, "0");
  const mismoMes = l.getUTCMonth() === viernes.getUTCMonth();
  return mismoMes
    ? `${p(l.getUTCDate())} al ${p(viernes.getUTCDate())} de ${MESES[l.getUTCMonth()]}`
    : `${p(l.getUTCDate())} ${MESES[l.getUTCMonth()]} al ${p(viernes.getUTCDate())} ${MESES[viernes.getUTCMonth()]}`;
}

// ─── xlsx: una hoja nueva por semana ──────────────────────────────────────────
const HEADERS = ["Día", "Fecha", "Hora", "Carátula", "Tipo", "Modalidad", "Juzgado/Lugar", "Link", "Asignado", "Notas"];
async function volcarAgenda(filas, nombreHoja) {
  let ExcelJS; try { ExcelJS = (await import("exceljs")).default; } catch { return { nota: "falta exceljs (npm i exceljs)" }; }
  const p = CFG.xlsxPath;
  const wb = new ExcelJS.Workbook();
  if (fs.existsSync(p)) await wb.xlsx.readFile(p);
  const previa = wb.getWorksheet(nombreHoja);
  if (previa) wb.removeWorksheet(previa.id); // re-corrida de la misma semana: reemplaza, no duplica
  const ws = wb.addWorksheet(nombreHoja.slice(0, 31));
  ws.addRow(HEADERS);
  ws.getRow(1).font = { bold: true };
  for (const f of filas) {
    ws.addRow([f.dia, f.fecha, f.hora, f.caratula, f.tipo, f.modalidad, f.lugar.replace(/\n/g, ", "), f.link, f.asignado, f.notas]);
  }
  ws.columns.forEach((c) => { c.width = 18; });
  await wb.xlsx.writeFile(p);
  return { archivo: p, filas: filas.length };
}

// ─── email ────────────────────────────────────────────────────────────────────
function crearTransport() {
  return nodemailer.createTransport({
    host: CFG.smtpHost, port: CFG.smtpPort, secure: CFG.smtpPort === 465,
    auth: { user: CFG.smtpUser, pass: CFG.smtpPass },
    connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 30000,
  });
}

function armarParte(filas, semanaDesc) {
  const porDia = new Map();
  for (const f of filas) { if (!porDia.has(f.dia)) porDia.set(f.dia, []); porDia.get(f.dia).push(f); }
  const orden = ["lunes", "martes", "miercoles", "jueves", "viernes"];
  const sinAsignar = filas.filter((f) => !f.asignado);
  const choques = filas.filter((f) => /CHOQUE/.test(f.notas));

  let texto = `AUDIENCIAS DE LA SEMANA (${semanaDesc})\n${filas.length} audiencia(s).\n\n`;
  let html = `<h2>AUDIENCIAS DE LA SEMANA</h2><p><b>${semanaDesc}</b> — ${filas.length} audiencia(s).</p>`;

  if (choques.length) {
    texto += `>>> CHOQUES DE HORARIO (${choques.length}) <<<\n`;
    html += `<div style="border:2px solid #b91c1c;border-radius:4px;padding:8px 10px;margin:10px 0"><b style="color:#b91c1c">⚠ Choques de horario (${choques.length})</b></div>`;
  }
  if (sinAsignar.length) {
    texto += `>>> SIN ASIGNAR (${sinAsignar.length}) <<<\n`;
    html += `<div style="border:1px solid #b58900;border-radius:4px;padding:6px 10px;margin:10px 0;background:#fdf6e3"><b style="color:#b58900">Sin asignar (${sinAsignar.length})</b> — revisar y repartir a mano.</div>`;
  }

  if (!filas.length) {
    texto += "No hay audiencias cargadas en el calendario para esta semana.\n";
    html += "<p>No hay audiencias cargadas en el calendario para esta semana.</p>";
  }

  for (const dia of orden) {
    const del = porDia.get(dia);
    if (!del || !del.length) continue;
    const tituloDia = dia.charAt(0).toUpperCase() + dia.slice(1);
    texto += `\n== ${tituloDia} ==\n`;
    html += `<h3 style="margin:14px 0 4px;color:#1e3a8b">${tituloDia}</h3><ul>`;
    for (const f of del) {
      const choque = /CHOQUE/.test(f.notas) ? " ⚠CHOQUE" : "";
      const asig = f.asignado || "(sin asignar)";
      texto += `  [${f.hora}] ${f.caratula} — ${f.tipo || "s/tipo"} · ${f.modalidad || "s/modalidad"} · ${f.lugar.replace(/\n/g, ", ") || "s/lugar"} · Asignado: ${asig}${choque}\n`;
      if (f.link) texto += `      link: ${f.link}\n`;
      if (f.notas) texto += `      notas: ${f.notas}\n`;
      html += `<li><b>${f.hora}</b> ${f.caratula} — ${f.tipo || "s/tipo"} · ${f.modalidad || "s/modalidad"} · ${f.lugar.replace(/\n/g, ", ") || "s/lugar"}<br>` +
        `Asignado: <b>${asig}</b>${choque ? `<span style="color:#b91c1c"> ⚠ CHOQUE</span>` : ""}` +
        (f.link ? `<br><a href="${f.link}" target="_blank">${f.link}</a>` : "") +
        (f.notas ? `<br><span style="color:#777;font-size:12px">${f.notas}</span>` : "") + `</li>`;
    }
    html += "</ul>";
  }
  html += `<hr><p style="color:#888;font-size:12px">Generado automaticamente desde el calendario AUDIENCIAS, por reglas fijas (sin IA). Verificar tipo/modalidad/asignacion antes de confirmar — especialmente eventos con varias audiencias agrupadas ("TRES MEDIACIONES...") que quedan en una sola fila.</p>`;
  return { texto, html, sinAsignar: sinAsignar.length, choques: choques.length };
}

async function enviar({ texto, html }, filas, semanaDesc, sinAsignar, choques, adjuntos) {
  const t = crearTransport();
  const prefijo = (choques ? `[${choques} CHOQUE(S)] ` : "") + (sinAsignar ? `[${sinAsignar} SIN ASIGNAR] ` : "");
  const asunto = `${prefijo}AUDIENCIAS DE LA SEMANA (${semanaDesc}) - ${filas.length}`;
  log("Conectando al servidor de correo...");
  await t.sendMail({ from: CFG.mailFrom, to: CFG.mailTo, subject: asunto, text: texto, html, attachments: adjuntos });
  log(`Email enviado a ${CFG.mailTo}`);
}

function alertaLocal(err, motivoMailFallo) {
  const fecha = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short" }).format(new Date());
  const contenido = [
    "ALERTA CRITICA - Agenda de audiencias semanal", "===============================================", "",
    "La corrida FALLO y ademas NO se pudo enviar el mail de aviso.",
    "Revisar el calendario AUDIENCIAS a mano esta semana.", "",
    `Fecha/hora: ${fecha}`, `Error: ${err && err.message ? err.message : String(err)}`,
    `Motivo por el que no salio el mail: ${motivoMailFallo || "n/d"}`,
  ].join("\n");
  try { fs.writeFileSync(path.join(CFG.alertaLocalDir, "ALERTA_CRITICA_AGENDA.txt"), contenido + "\n"); log("Fallback local escrito."); } catch (e) { log(`No se pudo escribir el fallback local: ${e.message}`); }
  try { for (let i = 0; i < 5; i++) process.stdout.write("\x07"); } catch {}
}

async function enviarAlertaFalla(err) {
  if (!CFG.alertaFalla) return;
  if (!CFG.smtpUser || !CFG.smtpPass || !CFG.mailToAlerta) { alertaLocal(err, "faltan datos SMTP/MAIL_TO"); return; }
  try {
    const t = crearTransport();
    const fecha = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short", timeStyle: "short" }).format(new Date());
    await t.sendMail({
      from: CFG.mailFrom, to: CFG.mailToAlerta,
      subject: `[FALLA] Agenda de audiencias ${fecha} - la corrida NO se completo`,
      text: [`La agenda semanal de audiencias NO se genero.`, "", `Fecha/hora: ${fecha}`, `Error: ${err && err.message ? err.message : String(err)}`, "", "Accion: revisar ICAL_AUDIENCIAS_URL en .env (puede haber cambiado si se regenero la clave del calendario) y el calendario AUDIENCIAS a mano."].join("\n"),
    });
    log(`Alerta de falla enviada a ${CFG.mailToAlerta}`);
  } catch (e2) { alertaLocal(err, `fallo el envio del mail: ${e2.message}`); }
}

function registrarCorrida(resumen) {
  try { fs.appendFileSync(path.resolve(__dirname, "ultima-corrida-agenda.log"), `${new Date().toISOString()} | OK | ${resumen}\n`); } catch {}
  try { const a = path.join(CFG.alertaLocalDir, "ALERTA_CRITICA_AGENDA.txt"); if (fs.existsSync(a)) fs.unlinkSync(a); } catch {}
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function main() {
  for (const [k, v] of Object.entries({ SMTP_USER: CFG.smtpUser, SMTP_PASS: CFG.smtpPass, MAIL_TO: CFG.mailTo, ICAL_AUDIENCIAS_URL: CFG.icalUrl })) {
    if (!v) throw new Error(`Falta ${k} en .env`);
  }

  const { desde, hasta } = proximaSemana();
  const semanaDesc = nombreSemana(desde, hasta);
  log(`Semana objetivo: ${semanaDesc} (${desde.toISOString()} a ${hasta.toISOString()})`);

  const eventos = await obtenerEventos(CFG.icalUrl);
  log(`Calendario AUDIENCIAS: ${eventos.length} evento(s) totales.`);
  const enSemana = eventos.filter((e) => e.inicio >= desde && e.inicio < hasta);
  log(`En la semana objetivo: ${enSemana.length} evento(s).`);

  const filas = enSemana.map(clasificar).sort((a, b) => a.inicio - b.inicio);
  marcarChoques(filas);

  const nombreHoja = `Semana ${semanaDesc}`;
  const vx = await volcarAgenda(filas, nombreHoja);
  if (vx.nota) log(`Excel: ${vx.nota}`);
  else log(`Excel: ${vx.filas} fila(s) volcadas en la hoja "${nombreHoja}" (${vx.archivo}).`);

  const parte = armarParte(filas, semanaDesc);
  const adjuntos = vx.archivo && fs.existsSync(vx.archivo) ? [{ filename: path.basename(vx.archivo), content: fs.readFileSync(vx.archivo) }] : [];
  await enviar(parte, filas, semanaDesc, parte.sinAsignar, parte.choques, adjuntos);

  registrarCorrida(`${filas.length} audiencias, ${parte.sinAsignar} sin asignar, ${parte.choques} choques`);
}

main().then(() => process.exit(0)).catch(async (e) => {
  console.error("ERROR:", e.message);
  await enviarAlertaFalla(e);
  process.exit(1);
});
