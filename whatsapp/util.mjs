/** Utilidades comunes del modulo WhatsApp (API oficial de Meta, sin terceros). Sin dependencias. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

(function cargarEnv() {
  const p = path.join(RAIZ, ".env");
  if (!fs.existsSync(p)) return;
  for (const l of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

export const cfg = () => ({
  token: (process.env.WHATSAPP_TOKEN || "").trim(),
  phoneId: (process.env.WHATSAPP_PHONE_ID || "").trim(),
  appSecret: (process.env.WHATSAPP_APP_SECRET || "").trim(),
  verifyToken: (process.env.WHATSAPP_VERIFY_TOKEN || "").trim(),
  puerto: Number(process.env.WHATSAPP_PORT || 8787),
  api: (process.env.WHATSAPP_API_BASE || "https://graph.facebook.com/v21.0").replace(/\/+$/, ""),
});

export const DIR_DATOS = process.env.WHATSAPP_DATA_DIR || path.join(RAIZ, "data", "whatsapp");
export const ARCHIVO = path.join(DIR_DATOS, "mensajes.jsonl");

export function agregar(registro) {
  fs.mkdirSync(DIR_DATOS, { recursive: true, mode: 0o700 });
  fs.appendFileSync(ARCHIVO, JSON.stringify(registro) + "\n", { mode: 0o600 });
}

export function leerTodo() {
  try { return fs.readFileSync(ARCHIVO, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}

/** Agrupa los mensajes por contacto: [{waId, nombre, ultimo, mensajes:[...]}], ordenado por actividad. */
export function conversaciones(dias = 30) {
  const desde = Date.now() - dias * 86400000;
  const por = new Map();
  for (const m of leerTodo()) {
    if (m.ts * 1000 < desde) continue;
    const c = por.get(m.waId) || { waId: m.waId, nombre: "", mensajes: [] };
    if (m.dir === "in" && m.nombre) c.nombre = m.nombre;
    c.mensajes.push({ id: m.id, dir: m.dir, ts: m.ts, tipo: m.tipo, texto: m.texto });
    por.set(m.waId, c);
  }
  return [...por.values()].map((c) => {
    c.mensajes.sort((a, b) => a.ts - b.ts);
    const entrantes = c.mensajes.filter((m) => m.dir === "in");
    c.ultimo = c.mensajes[c.mensajes.length - 1].ts;
    c.ultimoEntrante = entrantes.length ? entrantes[entrantes.length - 1].ts : 0;
    c.ventanaAbierta = c.ultimoEntrante && Date.now() / 1000 - c.ultimoEntrante < 24 * 3600; // Meta: respuestas libres solo dentro de las 24 h
    return c;
  }).sort((a, b) => b.ultimo - a.ultimo);
}
