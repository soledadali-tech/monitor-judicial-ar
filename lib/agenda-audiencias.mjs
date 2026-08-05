/**
 * agenda-audiencias.mjs - Deteccion de audiencias (fecha/hora) en el texto de un
 * despacho/cedula, y armado de un archivo .ics para agendarlas con un clic.
 *
 * MUY orientativo: busca patrones de fecha/hora "cerca" de la palabra "audiencia" o
 * "vista de causa" en el texto ya extraido del PDF (ver pdf-parse en el llamador).
 * "vista" sola NO dispara esto (a menudo es "correr vista" = plazo para responder por
 * escrito, no una audiencia con hora); solo "audiencia" o la frase completa "vista de
 * causa" (la audiencia preliminar del art. 360 CPCCN se llama asi). NUNCA reemplaza
 * leer el PDF: el mail y el .ics siempre incluyen el fragmento de texto de donde salio
 * la fecha, para que se pueda verificar de un vistazo.
 */

const MESES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

const RX_KEYWORD = /audiencia|vista de causa/gi;
const RX_FECHA_NUM = /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/g;
const RX_FECHA_TXT = /\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s+de\s+(\d{4})\b/gi;
const RX_HORA = /\b(\d{1,2})[:.](\d{2})\s*(?:hs?\.?|horas?)?\b|\b(\d{1,2})\s*(?:hs?\.?|horas?)\b/i;

function anioPlausible(a, base = new Date().getFullYear()) {
  return a >= base - 1 && a <= base + 3;
}

function normalizarFecha(d, m, a) {
  const anio = a < 100 ? 2000 + a : a;
  if (m < 1 || m > 12 || d < 1 || d > 31 || !anioPlausible(anio)) return null;
  const fecha = new Date(anio, m - 1, d);
  return isNaN(fecha) ? null : fecha;
}

// Candidatos de fecha dentro de un fragmento de texto, con su posicion (para medir
// distancia a la palabra clave) y si tienen hora asociada cerca (+/-60 chars).
function candidatosDeFecha(texto) {
  const out = [];
  for (const m of texto.matchAll(RX_FECHA_NUM)) {
    const f = normalizarFecha(Number(m[1]), Number(m[2]), Number(m[3]));
    if (f) out.push({ fecha: f, pos: m.index, largo: m[0].length });
  }
  for (const m of texto.matchAll(RX_FECHA_TXT)) {
    const f = normalizarFecha(Number(m[1]), MESES[m[2].toLowerCase()], Number(m[3]));
    if (f) out.push({ fecha: f, pos: m.index, largo: m[0].length });
  }
  for (const c of out) {
    const ventana = texto.slice(Math.max(0, c.pos - 10), c.pos + c.largo + 60);
    const h = ventana.match(RX_HORA);
    if (h) {
      const hh = Number(h[1] ?? h[3]), mm = Number(h[2] ?? 0);
      if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) { c.hora = { hh, mm }; c.horaTexto = h[0].trim(); }
    }
  }
  return out;
}

/**
 * Busca la mejor fecha/hora de audiencia cerca de "audiencia"/"vista de causa" en el
 * texto. Devuelve null si no encuentra nada razonable, o:
 *   { fecha: Date, hora: {hh,mm}|null, confianza: "alta"|"media", contexto: string }
 * confianza "alta" = fecha Y hora explicitas a menos de ~150 chars de la palabra clave.
 * confianza "media" = solo fecha, o hora mas lejana.
 */
export function extraerAudiencia(texto) {
  const t = String(texto || "").replace(/\s+/g, " ");
  if (!t) return null;
  const keywords = [...t.matchAll(RX_KEYWORD)];
  if (!keywords.length) return null;

  let mejor = null;
  for (const kw of keywords) {
    // Ventana amplia alrededor de la palabra clave (las convocatorias suelen decir
    // "AUDIENCIA... para el dia X" con texto de por medio).
    const desde = Math.max(0, kw.index - 80);
    const hasta = Math.min(t.length, kw.index + 500);
    const ventana = t.slice(desde, hasta);
    for (const c of candidatosDeFecha(ventana)) {
      const distancia = Math.abs((desde + c.pos) - kw.index);
      const confianza = c.hora && distancia <= 150 ? "alta" : "media";
      const rank = (c.hora ? 0 : 2) + (distancia <= 150 ? 0 : 1); // menor = mejor
      if (!mejor || rank < mejor.rank) {
        mejor = {
          fecha: c.fecha, hora: c.hora || null, confianza, rank,
          contexto: ventana.slice(Math.max(0, c.pos - 40), c.pos + c.largo + 80).trim(),
        };
      }
    }
  }
  if (!mejor) return null;
  delete mejor.rank;
  return mejor;
}

// ── .ics ────────────────────────────────────────────────────────────────────
function escaparICS(s) {
  return String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
function fmtICS(d) {
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
// Argentina es UTC-3 fijo (sin horario de verano desde 2009): sumar 3hs a la hora
// local para pasar a UTC en el .ics.
function localArAUtc(fecha, hh, mm) {
  const d = new Date(Date.UTC(fecha.getFullYear(), fecha.getMonth(), fecha.getDate(), hh + 3, mm, 0));
  return d;
}

/**
 * Arma un .ics (VCALENDAR/VEVENT) para una audiencia detectada. Si no hay hora
 * (confianza "media" sin hora), arma un evento de "todo el dia" para no inventar un
 * horario. duracionMin solo aplica cuando hay hora (default 60).
 */
export function generarICS({ uid, titulo, descripcion, ubicacion, fecha, hora, duracionMin = 60 }) {
  const dtstamp = fmtICS(new Date());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//monitor-judicial-ar//audiencias//ES", "CALSCALE:GREGORIAN", "BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${dtstamp}`];
  if (hora) {
    const inicio = localArAUtc(fecha, hora.hh, hora.mm);
    const fin = new Date(inicio.getTime() + duracionMin * 60000);
    lines.push(`DTSTART:${fmtICS(inicio)}`, `DTEND:${fmtICS(fin)}`);
  } else {
    const p = (n) => String(n).padStart(2, "0");
    const ymd = `${fecha.getFullYear()}${p(fecha.getMonth() + 1)}${p(fecha.getDate())}`;
    lines.push(`DTSTART;VALUE=DATE:${ymd}`);
  }
  lines.push(`SUMMARY:${escaparICS(titulo)}`);
  if (descripcion) lines.push(`DESCRIPTION:${escaparICS(descripcion)}`);
  if (ubicacion) lines.push(`LOCATION:${escaparICS(ubicacion)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n");
}
