#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
(function cargarEnv() {
  const p = path.resolve(__dirname, ".env");
  if (!fs.existsSync(p)) return;
  for (const l of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

const API = "https://api.pjn.gov.ar";
const HOME_URL = "https://portalpjn.pjn.gov.ar/inicio";
const profileDir = process.env.PROFILE_DIR || path.resolve(__dirname, ".pjn-profile");
const headless = (process.env.HEADLESS || "true") !== "false";
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function obtenerToken() {
  fs.mkdirSync(profileDir, { recursive: true });
  const browser = await puppeteer.launch({ headless: headless ? "new" : false, userDataDir: profileDir, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  try {
    const page = (await browser.pages())[0] || (await browser.newPage());
    let token = null;
    page.on("request", (req) => { const a = req.headers()["authorization"]; if (a && /^Bearer .{20,}/.test(a)) token = a.slice(7); });
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    for (let i = 0; i < 15 && !token; i++) await new Promise((r) => setTimeout(r, 1000));
    if (!token && page.url().includes("sso.pjn.gov.ar")) {
      if (!process.env.PJN_USER || !process.env.PJN_PASS) throw new Error("Sesion caducada y faltan PJN_USER/PJN_PASS en .env");
      await page.waitForSelector("#username", { timeout: 20000 });
      await page.type("#username", process.env.PJN_USER, { delay: 15 });
      await page.type("#password", process.env.PJN_PASS, { delay: 15 });
      await Promise.all([page.click("#kc-login").catch(() => page.keyboard.press("Enter")), page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {})]);
      for (let i = 0; i < 20 && !token; i++) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!token) throw new Error("No se capturo el token");
    return token;
  } finally { await browser.close().catch(() => {}); }
}


// Diagnostico: que trae el feed /eventos del Portal PJN entre DESDE y hoy, con y sin
// el filtro categoria=judicial que usa el parte diario. Uso:
//   DESDE=2026-10-20 node inspeccionar-feed-pjn.mjs
const DESDE = Date.parse((process.env.DESDE || "2026-10-20") + "T00:00:00-03:00");
const fmt = (ms) => ms ? new Date(Number(ms) - 3 * 3600000).toISOString().slice(0, 16).replace("T", " ") : "-";

async function feed(token, extra, maxPag = 15) {
  const out = []; let fechaHasta = null;
  for (let p = 0; p < maxPag; p++) {
    let ruta = `${API}/eventos/?page=${p}&pageSize=20${extra}`;
    if (fechaHasta) ruta += `&fechaHasta=${fechaHasta}`;
    const r = await fetch(ruta, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (!r.ok) { console.log(`  ${ruta} -> HTTP ${r.status}`); break; }
    const j = await r.json(); const lote = j.items || [];
    if (p === 0) { console.log(`  claves de la respuesta: ${Object.keys(j).join(", ")} | total=${j.total ?? j.totalElements ?? "?"}`); if (lote.length) fechaHasta = lote[0].fechaCreacion; }
    out.push(...lote);
    const masViejo = lote.length ? Math.min(...lote.map((x) => Number(x.fechaCreacion || x.fechaAccion || 0))) : 0;
    if (lote.length < 20 || masViejo < DESDE) break;
  }
  return out;
}
function linea(it) {
  const pl = it.payload || {};
  return `  id=${it.id} | creado ${fmt(it.fechaCreacion)} | accion ${fmt(it.fechaAccion)} | tipo=${it.tipo} | cat=${it.categoria ?? "-"} | ${pl.claveExpediente || "?"} | ${String(pl.caratulaExpediente || "").slice(0, 70)}`;
}

const token = await obtenerToken();
for (const [nombre, extra] of [["categoria=judicial (lo que usa el parte)", "&categoria=judicial"], ["SIN filtro de categoria", ""]]) {
  console.log(`\n===== Feed ${nombre}`);
  const items = (await feed(token, extra)).filter((it) => Number(it.fechaCreacion || it.fechaAccion || 0) >= DESDE);
  console.log(`  ${items.length} evento(s) desde ${process.env.DESDE || "2026-10-20"}`);
  for (const it of items) console.log(linea(it));
  if (items[0]) console.log(`  campos de un evento: ${Object.keys(items[0]).join(", ")} | payload: ${Object.keys(items[0].payload || {}).join(", ")}`);
}
