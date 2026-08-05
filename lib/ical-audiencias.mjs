/**
 * ical-audiencias.mjs - Lee el calendario "AUDIENCIAS" de Google Calendar via su
 * "Direccion secreta en formato iCal" (Configuracion del calendario > Integrar
 * calendario). Es una URL con un token: cualquier cliente HTTP la puede leer, sin
 * OAuth ni login. NO requiere IA: es un parser de texto (RFC 5545) mas reglas fijas.
 *
 * Config .env:  ICAL_AUDIENCIAS_URL=https://calendar.google.com/calendar/ical/.../private-XXXX/basic.ics
 */

function unfold(texto) {
  // RFC5545: una linea "continua" en la siguiente si esta empieza con espacio o tab.
  return String(texto || "").replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

function unescapeICS(s) {
  return String(s ?? "")
    .replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function sinHtml(s) {
  return String(s ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>.*?<\/a>/gi, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .trim();
}

// "DTSTART;TZID=...:20260811T090000" o "DTSTART:20260811T120000Z" -> Date
function parseFechaICS(linea) {
  const valor = linea.slice(linea.lastIndexOf(":") + 1).trim();
  const m = valor.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  // Sin Z: asumimos America/Argentina/Buenos_Aires (UTC-3 fijo, sin horario de verano).
  return new Date(Date.UTC(+y, +mo - 1, +d, +h + 3, +mi, +s));
}

function parseEvento(bloque) {
  const lineas = bloque.split("\n").filter(Boolean);
  const ev = { uid: "", summary: "", description: "", location: "", inicio: null, fin: null };
  for (const l of lineas) {
    if (l.startsWith("UID:")) ev.uid = l.slice(4).trim();
    else if (l.startsWith("SUMMARY:")) ev.summary = unescapeICS(l.slice(8));
    else if (l.startsWith("DESCRIPTION:")) ev.description = unescapeICS(l.slice(12));
    else if (l.startsWith("LOCATION:")) ev.location = unescapeICS(l.slice(9));
    else if (/^DTSTART/.test(l)) ev.inicio = parseFechaICS(l);
    else if (/^DTEND/.test(l)) ev.fin = parseFechaICS(l);
  }
  return ev.inicio ? ev : null;
}

export function parseICS(texto) {
  const bloques = unfold(texto).split("BEGIN:VEVENT").slice(1);
  const out = [];
  for (const b of bloques) {
    const fin = b.indexOf("END:VEVENT");
    const ev = parseEvento(fin >= 0 ? b.slice(0, fin) : b);
    if (ev) out.push(ev);
  }
  return out;
}

/** Descarga y parsea el calendario. Lanza si falla (el llamador decide como avisar). */
export async function obtenerEventos(url) {
  if (!url) throw new Error("falta ICAL_AUDIENCIAS_URL en .env");
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} descargando el calendario`);
  const texto = await r.text();
  return parseICS(texto);
}

export { sinHtml };
