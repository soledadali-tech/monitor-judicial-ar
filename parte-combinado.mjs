#!/usr/bin/env node
/**
 * parte-combinado.mjs - UN mail diario con PJN + MEV (pedido nov-2026).
 *
 * - Corre solo en dias HABILES (sin sabados, domingos ni feriados de feriados.json).
 * - Manana (antes de las 12 AR): manda siempre. Tarde: solo si hay novedades,
 *   prioritarias o una falla.
 * - Lunes a la manana: FOTO SEMANAL = estado de cada causa vigilada (ultimo
 *   movimiento). Martes a viernes: compara contra esa foto y lista lo que se movio,
 *   como control cruzado ademas de las novedades del dia.
 * - Corre parte-diario-pjn.mjs y parte-diario-mev.mjs con SALIDA_DIR (no mandan mail
 *   propio; si fallan, siguen mandando su mail de [FALLA]) y junta sus salidas.
 *
 * .env: CRON_COMBINADO=08:00,18:00 (en lugar de CRON_PJN / CRON_MEV).
 * Forzar a mano: FORZAR=1 node parte-combinado.mjs   (FORZAR_FOTO=1 para la foto)
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";
import { leerSalida } from "./lib/salida-parte.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
(function cargarEnv() {
  const p = path.resolve(__dirname, ".env");
  if (!fs.existsSync(p)) return;
  for (const l of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();
const log = (...a) => console.log(new Date().toISOString(), ...a);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── dia habil ──────────────────────────────────────────────────────────────────
const ahoraAR = new Date(Date.now() - 3 * 3600000); // AR = UTC-3 fijo
const isoHoy = ahoraAR.toISOString().slice(0, 10);
const dow = process.env.DIA_PRUEBA != null ? Number(process.env.DIA_PRUEBA) : ahoraAR.getUTCDay(); // DIA_PRUEBA: 0=dom..6=sab, solo pruebas
const tarde = ahoraAR.getUTCHours() >= 12;
function feriados() {
  const out = new Set((process.env.FERIADOS || "").split(",").map((s) => s.trim()).filter(Boolean));
  try {
    for (const raw of JSON.parse(fs.readFileSync(path.resolve(__dirname, "feriados.json"), "utf8"))) {
      const m = String(raw).match(/^(\d{4}-\d{2}-\d{2})\s*\.\.\s*(\d{4}-\d{2}-\d{2})$/);
      if (m) { for (let d = new Date(m[1] + "T00:00:00Z"); d <= new Date(m[2] + "T00:00:00Z"); d = new Date(d.getTime() + 86400000)) out.add(d.toISOString().slice(0, 10)); }
      else out.add(String(raw));
    }
  } catch {}
  return out;
}
const habil = dow !== 0 && dow !== 6 && !feriados().has(isoHoy);

// ── foto de la cartera ─────────────────────────────────────────────────────────
async function estadoCartera() {
  const ExcelJS = (await import("exceljs")).default;
  const out = [];
  // Ultimo paso MEV por causa segun el historial de movimientos (se actualiza en cada
  // corrida que consulta bien); la columna "Ult. Paso" de la cartera queda de respaldo.
  let ultMev = new Map();
  try { const { estadoPrevio } = await import("./lib/movimientos-mev.mjs"); ultMev = estadoPrevio(); } catch {}
  const fmt = (d) => d ? new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(d) : "";
  const leer = async (archivo, fn) => {
    const p = path.resolve(__dirname, archivo);
    if (!fs.existsSync(p)) return;
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(p);
    const ws = wb.worksheets.find((w) => /causa|exped/i.test(w.name)) || wb.worksheets[0];
    const col = {}; ws.getRow(1).eachCell((c, i) => { col[c.text.trim()] = i; });
    const v = (row, n) => (col[n] ? String(row.getCell(col[n]).text || "").trim() : "");
    for (let r = 2; r <= ws.rowCount; r++) { const row = ws.getRow(r); const x = fn((n) => v(row, n)); if (x) out.push(x); }
  };
  await leer("cartera-mev.xlsx", (v) => {
    if (/^(no|0|false)$/i.test(v("Vigilar")) || !/^si$/i.test(v("En Planilla")) || !v("NidCausa")) return null;
    const mv = ultMev.get(`${v("NidCausa")}|${v("PidJuzgado")}`);
    const ult = mv && mv.fecha ? fmt(mv.fecha) : v("Ult. Paso");
    return { sistema: "MEV", ref: v("Nro Expediente") || `nid ${v("NidCausa")}`, caratula: v("Caratula"), ult, id: mv ? mv.pasoId : "", det: mv ? "" : v("Detalle Ult. Paso") };
  });
  await leer("cartera-pjn.xlsx", (v) => {
    if (!v("Nro. Causa")) return null;
    return { sistema: "PJN", ref: v("Nro. Causa"), caratula: v("Caratula"), ult: v("Ult. Movimiento"), det: "" };
  });
  return out;
}
const FOTO = path.resolve(__dirname, "foto-semanal.json");

// ── correr un frente en modo salida ────────────────────────────────────────────
function correrFrente(script, logFile, dir) {
  const fd = fs.openSync(path.resolve(__dirname, logFile), "a");
  const r = spawnSync(process.execPath, [`--max-old-space-size=${Number(process.env.NODE_HIJO_MAX_MB || 320)}`, script], {
    cwd: __dirname, env: { ...process.env, SALIDA_DIR: dir }, stdio: ["ignore", fd, fd], timeout: 12 * 60000,
  });
  fs.closeSync(fd);
  return r.status;
}

async function main() {
  if (!habil && !process.env.FORZAR) { log(`No es dia habil (${isoHoy}): no se manda parte.`); return; }
  const dir = path.resolve(__dirname, ".salida");
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });

  let cPjn = "-", cMev = "-";
  if (!process.env.PRUEBA_SALIDAS) { // PRUEBA_SALIDAS=<dir>: usar salidas ya generadas (solo para probar el armado)
    log("Corriendo PJN..."); cPjn = correrFrente("parte-diario-pjn.mjs", "parte-pjn.log", dir);
    await new Promise((r) => setTimeout(r, 5000)); // que el SO libere la memoria de Chrome
    log("Corriendo MEV..."); cMev = correrFrente("parte-diario-mev.mjs", "parte-mev.log", dir);
  } else for (const f of fs.readdirSync(process.env.PRUEBA_SALIDAS)) fs.copyFileSync(path.join(process.env.PRUEBA_SALIDAS, f), path.join(dir, f));
  const pjn = leerSalida(dir, "PJN"), mev = leerSalida(dir, "MEV");
  log(`PJN codigo ${cPjn} ${pjn ? "ok" : "SIN SALIDA"} | MEV codigo ${cMev} ${mev ? "ok" : "SIN SALIDA"}`);

  // Foto semanal / cambios desde el lunes.
  const esLunes = dow === 1;
  let bloqueFoto = { texto: "", html: "" }, movidas = 0;
  try {
    const actual = await estadoCartera();
    let foto = null; try { foto = JSON.parse(fs.readFileSync(FOTO, "utf8")); } catch {}
    if ((esLunes && !tarde) || !foto || process.env.FORZAR_FOTO) {
      fs.writeFileSync(FOTO, JSON.stringify({ fecha: new Date().toISOString(), causas: actual }));
      bloqueFoto.texto = `>>> FOTO DE LA SEMANA - ${actual.length} causa(s) vigiladas (ultimo movimiento) <<<\n` + actual.map((c) => `  [${c.sistema}] ${c.ref} - ${c.caratula.slice(0, 70)} | ${c.ult || "sin dato"}${c.det ? " - " + c.det.slice(0, 60) : ""}`).join("\n") + "\n\n";
      bloqueFoto.html = `<div style="border:1px solid #1e3a8b;border-radius:4px;padding:8px 10px;margin:10px 0"><b style="color:#1e3a8b">📸 Foto de la semana - ${actual.length} causa(s) vigiladas</b><div style="font-size:12px;color:#555">Base para controlar la semana: martes a viernes el parte avisa qué se movió contra esta foto.</div><table style="border-collapse:collapse;font-size:12px;margin-top:6px;width:100%">` +
        `<tr style="background:#eef"><th align="left">Sist.</th><th align="left">Causa</th><th align="left">Último movimiento</th></tr>` +
        actual.map((c) => `<tr style="border-top:1px solid #ddd"><td>${c.sistema}</td><td><b>${esc(c.ref)}</b> ${esc(c.caratula.slice(0, 80))}</td><td>${esc(c.ult || "sin dato")}${c.det ? `<br><span style="color:#777">${esc(c.det.slice(0, 80))}</span>` : ""}</td></tr>`).join("") + `</table></div>`;
    } else {
      const prev = new Map((foto.causas || []).map((c) => [`${c.sistema}|${c.ref}`, c]));
      const cambios = actual.filter((c) => { const p = prev.get(`${c.sistema}|${c.ref}`); return !p || (c.id && c.id !== p.id) || (c.ult && c.ult !== p.ult); });
      movidas = cambios.length;
      const desde = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short" }).format(new Date(foto.fecha));
      if (cambios.length) {
        bloqueFoto.texto = `>>> CONTROL SEMANAL - ${cambios.length} causa(s) se movieron desde la foto del ${desde} <<<\n` + cambios.map((c) => `  [${c.sistema}] ${c.ref} - ${c.caratula.slice(0, 70)} | ${prev.has(`${c.sistema}|${c.ref}`) ? `${prev.get(`${c.sistema}|${c.ref}`).ult || "sin dato"} -> ` : "NUEVA -> "}${c.ult}`).join("\n") + "\n\n";
        bloqueFoto.html = `<div style="border:1px solid #1e3a8b;border-radius:4px;padding:8px 10px;margin:10px 0"><b style="color:#1e3a8b">Control semanal: ${cambios.length} causa(s) se movieron desde la foto del ${desde}</b><ul style="margin:6px 0;font-size:13px">` +
          cambios.map((c) => `<li>[${c.sistema}] <b>${esc(c.ref)}</b> ${esc(c.caratula.slice(0, 70))} &mdash; ${prev.has(`${c.sistema}|${c.ref}`) ? esc(prev.get(`${c.sistema}|${c.ref}`).ult || "sin dato") + " &rarr; " : "NUEVA &rarr; "}<b>${esc(c.ult)}</b></li>`).join("") + `</ul></div>`;
      } else {
        bloqueFoto.texto = `Control semanal: ninguna causa se movio desde la foto del ${desde}.\n\n`;
        bloqueFoto.html = `<p style="color:#555;font-size:13px">Control semanal: ninguna causa se movió desde la foto del ${desde}.</p>`;
      }
    }
  } catch (e) { log(`Foto semanal omitida: ${e.message}`); }

  const novedades = (pjn?.novedades || 0) + (mev?.novedades || 0);
  const prioritarias = (pjn?.prioritarias || 0) + (mev?.prioritarias || 0);
  const hayFalla = !pjn || !mev || !!mev?.falla;
  if (tarde && !novedades && !prioritarias && !hayFalla && !process.env.FORZAR) { log("Tarde sin novedades ni fallas: no se manda mail."); return; }

  const fechaCorta = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "short" }).format(new Date());
  const fechaLarga = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", dateStyle: "full" }).format(new Date());
  // Asunto: banderas de MEV (clave/falla/caducidad) + prioritarias totales + resumen.
  const flagsMev = (mev?.prefijo || "").replace(/\[\d+ PRIORITARIA\(S\)\] /, "");
  const flagsPjn = (pjn?.prefijo || "").replace(/\[\d+ PRIORITARIA\(S\)\] /, "").replace(/\[REVISION CADUCIDAD/g, "[PJN CADUCIDAD");
  const asunto = `${esLunes && !tarde ? "[FOTO SEMANAL] " : ""}${!pjn ? "[FALLA PJN] " : ""}${!mev ? "[FALLA MEV] " : ""}${flagsMev}${flagsPjn}${prioritarias ? `[${prioritarias} PRIORITARIA(S)] ` : ""}Parte diario ${fechaCorta}${tarde ? " (tarde)" : ""} - PJN ${pjn ? pjn.novedades : "?"} / MEV ${mev ? mev.novedades : "?"} novedad(es)`;

  const resumenHtml = `<table style="border-collapse:collapse;font-size:14px;margin:6px 0"><tr><td style="padding:2px 10px 2px 0"><b>PJN</b></td><td>${pjn ? `${pjn.novedades} novedad(es), ${pjn.prioritarias} prioritaria(s)` : "<b style='color:#8b1e1e'>no se pudo generar (ver mail de FALLA)</b>"}</td></tr>` +
    `<tr><td style="padding:2px 10px 2px 0"><b>MEV</b></td><td>${mev ? `${mev.novedades} novedad(es), ${mev.prioritarias} prioritaria(s)${mev.falla ? ` &mdash; <b style="color:#8b1e1e">${mev.falla === "total" ? "no se pudo consultar ninguna causa" : `${mev.fallidas} causa(s) sin consultar`}</b>` : ""}` : "<b style='color:#8b1e1e'>no se pudo generar (ver mail de FALLA)</b>"}</td></tr>` +
    `${movidas ? `<tr><td style="padding:2px 10px 2px 0"><b>Semana</b></td><td>${movidas} causa(s) se movieron desde el lunes</td></tr>` : ""}</table>`;
  const sacarH2 = (h) => String(h || "").replace(/^<h2>[^<]*<\/h2>/, "");
  const html = `<h2 style="margin:0">Parte diario judicial</h2><div style="color:#555">${fechaLarga}${tarde ? " &middot; corrida de la tarde" : ""}</div>${resumenHtml}${bloqueFoto.html}` +
    `<h2 style="border-bottom:2px solid #1e3a8b;margin-top:18px">PJN - Justicia Nacional</h2>${pjn ? sacarH2(pjn.html) : "<p>Sin datos.</p>"}` +
    `<h2 style="border-bottom:2px solid #1e3a8b;margin-top:18px">MEV - Provincia de Buenos Aires</h2>${mev ? sacarH2(mev.html) : "<p>Sin datos.</p>"}`;
  const texto = `Parte diario judicial - ${fechaLarga}${tarde ? " (tarde)" : ""}\nPJN: ${pjn ? pjn.novedades + " novedad(es)" : "FALLA"} | MEV: ${mev ? mev.novedades + " novedad(es)" : "FALLA"}\n\n${bloqueFoto.texto}` +
    `==================== PJN ====================\n${pjn ? pjn.texto : "Sin datos."}\n\n==================== MEV ====================\n${mev ? mev.texto : "Sin datos."}\n`;
  const adjuntos = [...(pjn?.adjuntos || []), ...(mev?.adjuntos || [])];

  const t = nodemailer.createTransport({ host: process.env.SMTP_HOST || "smtp.gmail.com", port: Number(process.env.SMTP_PORT || 465), secure: Number(process.env.SMTP_PORT || 465) === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  try {
    await t.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to: process.env.MAIL_TO, subject: asunto, text: texto, html, attachments: adjuntos });
    log(`Mail combinado enviado: ${asunto}`);
    fs.appendFileSync(path.resolve(__dirname, "ultima-corrida-combinado.log"), `${new Date().toISOString()} | OK | ${asunto}\n`);
  } catch (e) {
    fs.writeFileSync(path.resolve(__dirname, "ultimo-parte-no-enviado.html"), html);
    fs.appendFileSync(path.resolve(__dirname, "ultima-corrida-combinado.log"), `${new Date().toISOString()} | ERROR mail | ${e.message}\n`);
    throw e;
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
