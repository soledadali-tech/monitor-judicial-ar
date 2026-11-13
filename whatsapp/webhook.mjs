#!/usr/bin/env node
/**
 * Receptor del webhook de la API de WhatsApp Business de Meta (directo, sin terceros).
 * Escucha en 127.0.0.1:WHATSAPP_PORT (un proxy con HTTPS lo expone: ver DESPLIEGUE-WHATSAPP.md).
 *   GET  /whatsapp/webhook  -> verificacion de Meta (hub.verify_token)
 *   POST /whatsapp/webhook  -> mensajes entrantes; SOLO se aceptan con firma X-Hub-Signature-256 valida (app secret)
 * Guarda cada mensaje en data/whatsapp/mensajes.jsonl. No responde ni envia nada.
 */
import http from "node:http";
import crypto from "node:crypto";
import { cfg, agregar } from "./util.mjs";

const C = cfg();
const MAX = 1024 * 1024;

export function firmaValida(cuerpo, cabecera, secreto) {
  if (!secreto || !cabecera || !String(cabecera).startsWith("sha256=")) return false;
  const esperada = crypto.createHmac("sha256", secreto).update(cuerpo).digest("hex");
  const recibida = String(cabecera).slice(7);
  return recibida.length === esperada.length && crypto.timingSafeEqual(Buffer.from(esperada), Buffer.from(recibida));
}

export function procesar(payload) {
  let n = 0;
  for (const entry of payload.entry || []) for (const ch of entry.changes || []) {
    const v = ch.value || {};
    const nombres = new Map((v.contacts || []).map((c) => [c.wa_id, c.profile?.name || ""]));
    for (const m of v.messages || []) {
      const texto = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? m.caption ?? `[${m.type}]`;
      agregar({ dir: "in", id: m.id, waId: m.from, nombre: nombres.get(m.from) || "", ts: Number(m.timestamp) || Math.floor(Date.now() / 1000), tipo: m.type, texto: String(texto).slice(0, 4000) });
      n++;
    }
  }
  return n;
}

export const servidor = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/whatsapp/webhook") { res.writeHead(404).end(); return; }
  if (req.method === "GET") {
    const ok = url.searchParams.get("hub.mode") === "subscribe" && C.verifyToken && url.searchParams.get("hub.verify_token") === C.verifyToken;
    if (ok) { res.writeHead(200, { "Content-Type": "text/plain" }).end(url.searchParams.get("hub.challenge") || ""); } else { res.writeHead(403).end(); }
    return;
  }
  if (req.method !== "POST") { res.writeHead(405).end(); return; }
  const trozos = []; let tam = 0;
  req.on("data", (d) => { tam += d.length; if (tam > MAX) { res.writeHead(413).end(); req.destroy(); } else trozos.push(d); });
  req.on("end", () => {
    const cuerpo = Buffer.concat(trozos);
    if (!firmaValida(cuerpo, req.headers["x-hub-signature-256"], C.appSecret)) { res.writeHead(403).end(); return; }
    try { procesar(JSON.parse(cuerpo.toString("utf8"))); } catch (e) { console.error("payload invalido:", e.message); }
    res.writeHead(200).end("ok"); // Meta reintenta si no recibe 200
  });
});

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!C.appSecret || !C.verifyToken) { console.error("Faltan WHATSAPP_APP_SECRET y/o WHATSAPP_VERIFY_TOKEN en .env"); process.exit(1); }
  servidor.listen(C.puerto, "127.0.0.1", () => console.log(`Webhook de WhatsApp escuchando en 127.0.0.1:${C.puerto}`));
}
