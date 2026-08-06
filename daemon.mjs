#!/usr/bin/env node
/**
 * daemon.mjs - Scheduler propio, configurado enteramente desde el .env. Alternativa a
 * agendar.mjs (que escribe tareas en crontab/Programador de tareas, FUERA del repo).
 *
 * Pensado para VPS/systemd: un solo proceso de larga duracion (restart=always) que
 * dispara cada parte a la hora que digas en el .env, sin depender del cron ni del
 * timezone del sistema operativo (calcula todo en hora de Argentina, UTC-3 fijo, sin
 * horario de verano desde 2009 - el mismo dolor de cabeza que documenta
 * DESPLIEGUE-VPS.md para crontab, resuelto de raiz).
 *
 * Config .env (todas opcionales; un frente sin variable simplemente no se agenda):
 *   CRON_PJN=08:00,18:00
 *   CRON_MEV=08:30
 *   CRON_EJE=09:00
 *   CRON_AGENDA=18:00        (agenda de audiencias semanal)
 *   CRON_AGENDA_DIA=miercoles (opcional: solo ese dia; sin esto dispararia TODOS los dias)
 *   CRON_BACKUP=20:00        (backup semanal de cartera/movimientos por mail)
 *   CRON_BACKUP_DIA=domingo  (opcional: solo ese dia; sin esto dispararia TODOS los dias)
 * Formato HH:MM (24hs), varios horarios separados por coma.
 *
 * Uso:  node daemon.mjs          (foreground; Ctrl+C para salir)
 * VPS:  systemd con Restart=always (ver DESPLIEGUE-VPS.md).
 *
 * Si una corrida sigue colgada cuando le toca disparar de nuevo, la saltea (no la
 * pisa) y lo deja en el log - mismo criterio que el "flock" que se sugiere para cron.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ─── alerta si el daemon mismo se cae ──────────────────────────────────────────
// systemd lo reinicia solo (Restart=always), pero sin esto nadie se entera de que
// paso — el proceso vuelve a arrancar en silencio y las corridas que se perdieron
// entre la caida y el reinicio no dejan rastro. OJO: esto NO cubre el caso de que
// el VPS entero este caido/sin red (ahi no hay nada corriendo que pueda avisar) —
// para eso, el mail semanal de backup-datos.mjs funciona como heartbeat indirecto
// (si deja de llegar, algo esta mal). Nodemailer directo, sin depender de los
// scripts hijos (que ya tienen su propia alerta de falla, pero solo cubre errores
// DENTRO de su propio main(), no un crash del daemon que los agenda).
let mandandoAlerta = false;
async function alertaCritica(motivo, detalle) {
  if (mandandoAlerta) return; // no encadenar alertas si la alerta misma tira error
  mandandoAlerta = true;
  try {
    const smtpUser = process.env.SMTP_USER, smtpPass = process.env.SMTP_PASS;
    const mailTo = process.env.MAIL_TO_ALERTA || process.env.MAIL_TO;
    if (!smtpUser || !smtpPass || !mailTo) { log("No se pudo mandar alerta critica: faltan SMTP_USER/SMTP_PASS/MAIL_TO."); return; }
    const nodemailer = (await import("nodemailer")).default;
    const t = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com", port: Number(process.env.SMTP_PORT || 465),
      secure: Number(process.env.SMTP_PORT || 465) === 465, auth: { user: smtpUser, pass: smtpPass },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
    });
    await t.sendMail({
      from: process.env.MAIL_FROM || smtpUser, to: mailTo,
      subject: `[ALERTA CRITICA] daemon.mjs se cayo - ${motivo}`,
      text: [
        `El daemon de monitor-judicial-ar tuvo un error fatal y va a reiniciarse solo`,
        `(systemd Restart=always), pero las corridas agendadas para este momento se`,
        `pueden haber perdido.`,
        ``,
        `Motivo: ${motivo}`,
        `Detalle: ${detalle}`,
        ``,
        `Entrar por SSH al VPS y revisar: sudo systemctl status monitor-judicial`,
        `                                  sudo journalctl -u monitor-judicial -n 100`,
      ].join("\n"),
    });
    log(`Alerta critica enviada a ${mailTo}.`);
  } catch (e) {
    log(`No se pudo mandar la alerta critica: ${e.message}`);
  } finally {
    mandandoAlerta = false;
  }
}
process.on("uncaughtException", async (e) => {
  log(`[FATAL] uncaughtException: ${e && e.stack || e}`);
  await alertaCritica("uncaughtException", (e && e.stack) || String(e));
  process.exit(1);
});
process.on("unhandledRejection", async (e) => {
  log(`[FATAL] unhandledRejection: ${e && e.stack || e}`);
  await alertaCritica("unhandledRejection", (e && e.stack) || String(e));
  process.exit(1);
});

const FRENTES = {
  pjn: { script: "parte-diario-pjn.mjs", env: "CRON_PJN", logFile: "parte-pjn.log" },
  eje: { script: "parte-diario-eje.mjs", env: "CRON_EJE", logFile: "parte-eje.log" },
  mev: { script: "parte-diario-mev.mjs", env: "CRON_MEV", logFile: "parte-mev.log" },
  agenda: { script: "agenda-audiencias-semanal.mjs", env: "CRON_AGENDA", diaEnv: "CRON_AGENDA_DIA", logFile: "agenda.log" },
  backup: { script: "backup-datos.mjs", env: "CRON_BACKUP", diaEnv: "CRON_BACKUP_DIA", logFile: "backup.log" },
};

function horasDe(envVar) {
  const raw = (process.env[envVar] || "").trim();
  if (!raw) return [];
  const out = [];
  for (const s of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = s.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (!m) { log(`ADVERTENCIA: horario invalido en ${envVar}="${s}" (formato HH:MM, 24hs). Ignorado.`); continue; }
    out.push({ h: Number(m[1]), m: Number(m[2]), txt: s });
  }
  return out;
}

const DIAS_SEMANA = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, "miércoles": 3, jueves: 4, viernes: 5, sabado: 6, "sábado": 6 };
function diaSemanaDe(envVar) {
  const raw = (process.env[envVar] || "").trim().toLowerCase();
  if (!raw) return null; // sin dia especifico: dispara todos los dias
  if (!(raw in DIAS_SEMANA)) { log(`ADVERTENCIA: dia invalido en ${envVar}="${raw}" (lunes..domingo). Se ignora, dispara todos los dias.`); return null; }
  return DIAS_SEMANA[raw];
}

// Proximo instante (Date, UTC internamente) que corresponde a esa hora:minuto en
// horario de Argentina (UTC-3 fijo), opcionalmente restringido a un dia de la semana
// especifico (0=domingo..6=sabado). No depende del TZ del proceso/SO.
function proximaFechaAR(hora, diaSemana = null) {
  const ahora = Date.now();
  const inicioDiaUTC = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  let candidato = inicioDiaUTC + (hora.h + 3) * 3600000 + hora.m * 60000;
  while (candidato <= ahora) candidato += 24 * 3600000;
  if (diaSemana != null) {
    // El "dia" en hora de Argentina es el de (candidato - 3hs).
    while (new Date(candidato - 3 * 3600000).getUTCDay() !== diaSemana) candidato += 24 * 3600000;
  }
  return new Date(candidato);
}

const corriendo = new Set();

function correr(frente) {
  if (corriendo.has(frente.script)) {
    log(`[SKIP] ${frente.script} - la corrida anterior todavia esta activa, no se dispara de nuevo.`);
    return;
  }
  corriendo.add(frente.script);
  log(`[INICIO] ${frente.script}`);
  const fd = fs.openSync(path.resolve(__dirname, frente.logFile), "a");
  const child = spawn(process.execPath, [frente.script], { cwd: __dirname, stdio: ["ignore", fd, fd] });
  child.on("exit", (code) => {
    fs.closeSync(fd);
    corriendo.delete(frente.script);
    log(`[FIN] ${frente.script} - codigo ${code}${code !== 0 ? " (revisar " + frente.logFile + ")" : ""}`);
  });
  child.on("error", (e) => {
    fs.closeSync(fd);
    corriendo.delete(frente.script);
    log(`[ERROR] no se pudo lanzar ${frente.script}: ${e.message}`);
  });
}

function programar(frente, hora, diaSemana) {
  const proxima = proximaFechaAR(hora, diaSemana);
  const ms = proxima.getTime() - Date.now();
  setTimeout(() => { correr(frente); programar(frente, hora, diaSemana); }, ms);
  const diaTxt = diaSemana != null ? ` (los ${Object.keys(DIAS_SEMANA).find((k) => DIAS_SEMANA[k] === diaSemana && k.length > 5) || diaSemana})` : "";
  log(`[AGENDADO] ${frente.script} @ ${hora.txt} AR${diaTxt} -> proxima corrida en ${Math.round(ms / 60000)} min (${proxima.toISOString()})`);
}

function main() {
  log("=== daemon.mjs iniciado ===");
  let algo = false;
  for (const frente of Object.values(FRENTES)) {
    const horas = horasDe(frente.env);
    if (!horas.length) { log(`[OMITIDO] ${frente.script}: sin ${frente.env} en .env`); continue; }
    const diaSemana = frente.diaEnv ? diaSemanaDe(frente.diaEnv) : null;
    for (const hora of horas) programar(frente, hora, diaSemana);
    algo = true;
  }
  if (!algo) {
    log("Nada agendado: cargar CRON_PJN / CRON_MEV / CRON_EJE en .env (formato HH:MM, separados por coma).");
    log("El proceso sigue vivo por si se agrega despues, pero no va a disparar nada hasta reiniciarlo con las variables cargadas.");
  }
  log("Daemon activo. Ctrl+C para salir (o `systemctl stop <servicio>` en el VPS).");
}

process.on("SIGTERM", () => { log("SIGTERM recibido, saliendo."); process.exit(0); });
process.on("SIGINT", () => { log("SIGINT recibido, saliendo."); process.exit(0); });

main();
