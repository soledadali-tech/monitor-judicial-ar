#!/usr/bin/env node
/**
 * Envia UNA respuesta de texto por la API de Meta. Solo se usa cuando la abogada aprueba el envio (boton del Despacho).
 *   node whatsapp/enviar.mjs <waId>      (el texto llega por stdin)
 * Reglas: solo a contactos que escribieron en las ultimas 24 h (ventana de atencion de Meta); un mensaje por llamada.
 */
import { cfg, agregar, conversaciones } from "./util.mjs";

const C = cfg();
const waId = String(process.argv[2] || "").replace(/\D/g, "");
let texto = ""; for await (const d of process.stdin) texto += d;
texto = texto.trim();
const salir = (obj, code = 0) => { console.log(JSON.stringify(obj)); process.exit(code); };

if (!waId) salir({ ok: false, error: "Falta el número" }, 1);
if (!texto || texto.length > 4000) salir({ ok: false, error: "Texto vacío o demasiado largo" }, 1);
if (!C.token || !C.phoneId) salir({ ok: false, error: "Faltan WHATSAPP_TOKEN y WHATSAPP_PHONE_ID en .env" }, 1);
const conv = conversaciones(30).find((c) => c.waId === waId);
if (!conv) salir({ ok: false, error: "Ese contacto no escribió nunca" }, 1);
if (!conv.ventanaAbierta) salir({ ok: false, error: "Pasaron más de 24 h desde su último mensaje: Meta solo permite una plantilla aprobada" }, 1);

const r = await fetch(`${C.api}/${C.phoneId}/messages`, {
  method: "POST", headers: { Authorization: `Bearer ${C.token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ messaging_product: "whatsapp", to: waId, type: "text", text: { body: texto, preview_url: false } }),
  signal: AbortSignal.timeout(20000),
});
const j = await r.json().catch(() => ({}));
if (!r.ok) salir({ ok: false, error: j?.error?.message || `HTTP ${r.status}` }, 1);
agregar({ dir: "out", id: j?.messages?.[0]?.id || `out-${Date.now()}`, waId, nombre: "", ts: Math.floor(Date.now() / 1000), tipo: "text", texto });
salir({ ok: true, id: j?.messages?.[0]?.id });
