#!/usr/bin/env node
/**
 * backup-datos.mjs - Backup semanal de los datos locales por mail.
 *
 * cartera-*.xlsx, movimientos-*.csv, etc. viven UNICAMENTE en el disco de donde
 * corre el bot (en produccion, el VPS) — estan gitignored a proposito porque tienen
 * datos personales (actor/demandado/materia/firma de las causas). Sin backup, un
 * disco corrupto o una instancia perdida (Oracle Free tier no da garantias) se
 * lleva puesto todo: la cartera armada, el historial de "ya visto" que evita
 * repetir novedades, y el trabajo de cruce con la planilla ya resuelto.
 *
 * Este script no agrega infraestructura nueva: reusa las credenciales SMTP que ya
 * existen para los partes diarios y se manda el backup a si misma por mail (Gmail
 * guarda los adjuntos igual que cualquier otro mail — es un destino durable gratis).
 * Ademas funciona como heartbeat indirecto: si este mail semanal deja de llegar,
 * es señal de que el VPS/daemon dejaron de funcionar.
 *
 * Uso:  node backup-datos.mjs
 * Agendado por daemon.mjs via CRON_BACKUP / CRON_BACKUP_DIA en .env.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(new Date().toISOString(), ...a);

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
  mailTo: process.env.MAIL_TO_BACKUP || process.env.MAIL_TO || "",
};

// Cartera + historial de movimientos de los 3 frentes, agenda de audiencias y las
// tablas de feriados/ferias (chicas, pero sin ellas el computo de plazos se corre
// de fecha). NO se incluye planilla-causas-cache.json: es un cache re-descargable
// de Google Sheets, no un dato que el bot haya generado.
const ARCHIVOS = [
  "cartera-pjn.xlsx", "cartera-mev.xlsx", "cartera-eje.xlsx", "agenda-audiencias.xlsx",
  "movimientos-pjn.csv", "movimientos-mev.csv", "movimientos-eje.csv", "causas-pjn.csv",
  "feria-caba.json", "feria-pba.json", "feriados.json", "ferias-judiciales.json",
];

function crearTransport() {
  return nodemailer.createTransport({
    host: CFG.smtpHost, port: CFG.smtpPort, secure: CFG.smtpPort === 465,
    auth: { user: CFG.smtpUser, pass: CFG.smtpPass },
    connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 30000,
  });
}

async function main() {
  if (!CFG.smtpUser || !CFG.smtpPass || !CFG.mailTo) {
    console.error("Faltan SMTP_USER/SMTP_PASS/MAIL_TO en .env — no se puede mandar el backup.");
    process.exit(1);
  }
  const presentes = ARCHIVOS.filter((f) => fs.existsSync(path.join(__dirname, f)));
  if (!presentes.length) {
    log("Nada para respaldar todavia (ningun archivo de datos existe).");
    return;
  }
  const adjuntos = presentes.map((f) => ({ filename: f, content: fs.readFileSync(path.join(__dirname, f)) }));
  const totalKB = (adjuntos.reduce((a, b) => a + b.content.length, 0) / 1024).toFixed(0);
  const fecha = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "full" }).format(new Date());

  const texto = [
    `Backup automatico de monitor-judicial-ar - ${fecha}`,
    ``,
    `${presentes.length} archivo(s), ${totalKB} KB total:`,
    ...presentes.map((f) => `  - ${f}`),
    ``,
    `Este mail es tambien un heartbeat: si deja de llegar una semana, es señal de`,
    `que el VPS o el daemon dejaron de funcionar — entrar por SSH y revisar`,
    `"systemctl status monitor-judicial" / journalctl.`,
    ``,
    `Para restaurar: bajar los adjuntos y copiarlos a la carpeta del repo en el VPS`,
    `(mismos nombres de archivo), o a la Mac si se restaura ahi.`,
  ].join("\n");

  const t = crearTransport();
  await t.sendMail({
    from: CFG.mailFrom, to: CFG.mailTo,
    subject: `[Backup] monitor-judicial-ar - ${presentes.length} archivo(s) - ${new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short" }).format(new Date())}`,
    text: texto,
    attachments: adjuntos,
  });
  log(`Backup enviado a ${CFG.mailTo}: ${presentes.length} archivo(s), ${totalKB} KB.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
