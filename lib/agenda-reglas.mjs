/**
 * agenda-reglas.mjs - Clasificacion de audiencias por reglas fijas (SIN IA): tipo,
 * modalidad, lugar, link, notas y asignacion automatica, a partir de lo que ya trae
 * el evento del calendario (ver lib/ical-audiencias.mjs). Mismo glosario/prioridades
 * que usaba el flujo manual de Cowork.
 */
import { sinHtml } from "./ical-audiencias.mjs";

const DIAS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];

export function diaDe(fecha) {
  // fecha en hora de Argentina (el evento ya viene en Date/UTC real; restamos 3hs
  // para leer el dia-de-semana tal como lo veria alguien en Buenos Aires).
  const ar = new Date(fecha.getTime() - 3 * 3600000);
  return DIAS[ar.getUTCDay()];
}
export function fechaDDMM(fecha) {
  const ar = new Date(fecha.getTime() - 3 * 3600000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(ar.getUTCDate())}/${p(ar.getUTCMonth() + 1)}`;
}
export function horaHHMM(fecha) {
  const ar = new Date(fecha.getTime() - 3 * 3600000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(ar.getUTCHours())}:${p(ar.getUTCMinutes())}`;
}

// Orden de reglas: la primera que matchea gana (asi evita que "Test cont" caiga en "Test").
const REGLAS_TIPO = [
  [/test.*contr|contraria.*test/i, "Test cont"],
  [/conf.*ddo\b|conf.*demandad/i, "Conf ddo"],
  [/test.*mixt|mixt.*test/i, "Test mixta"],
  [/\btest\b|testimonial/i, "Test"],
  [/\bconf\b|confesional/i, "Conf"],
  [/\bconc\b|conciliator/i, "Conc"],
  [/\bseclo\b/i, "Seclo"],
  [/\bvista\b/i, "Vista"],
  [/\b360\b/i, "aud 360"],
  [/mediaci[oó]n/i, "Mediación"],
];
export function tipoDe(texto) {
  for (const [rx, tipo] of REGLAS_TIPO) if (rx.test(texto)) return tipo;
  return "";
}

export function modalidadDe(texto) {
  if (/\bvirtual\b|teams|meet\.google|zoom\.us|us0\dweb\.zoom|\b360\b/i.test(texto)) return "virtual";
  if (/\bpresencial\b/i.test(texto)) return "presencial";
  if (/\bmixt[ao]\b/i.test(texto)) return "mixta";
  if (/\bonline\b/i.test(texto)) return "virtual";
  return "";
}

// Lugar/juzgado: preferimos LOCATION si vino cargado; si no, lo intentamos sacar del
// titulo (patrones tipo "LZ. 14", "S.I. 8", "T2LZ", "JZG COMERCIAL 26", "13LZ").
const RX_LUGAR = /\b(?:JZG|JUZG(?:ADO)?)\.?\s*[A-ZÁÉÍÓÚÑ.]*\s*\d+\b|\bT\.?\s*\d+\s*(?:LZ|AV|LN)?\b|\b\d{1,2}\s*(?:LZ|AV|LN)\b|\bLZ\.?\s*\d+\b|\bS\.?I\.?\s*\d+\b/i;
export function lugarDe(location, summary) {
  const loc = sinHtml(location).trim();
  if (loc) return loc;
  const m = String(summary || "").match(RX_LUGAR);
  return m ? m[0].trim() : "";
}

// Link de videollamada: preferimos el href real de un <a>, si no la primera URL suelta.
export function linkDe(description) {
  const raw = String(description || "").replace(/<wbr\s*\/?>/gi, "");
  const href = raw.match(/href=["']([^"']+)["']/i);
  if (href) return href[1];
  const url = raw.match(/https?:\/\/[^\s<>"]+/i);
  return url ? url[0] : "";
}

// Notas: avisos de suspension/reprogramacion en la descripcion, mas el texto crudo
// cuando no hay link (para no perder informacion, ej. el detalle de "TRES MEDIACIONES").
const RX_AVISO = /se\s+(pasa|suspende|reprograma)[^.\n]*|suspendid[oa][^.\n]*|reprogramad[oa][^.\n]*|cliente\s+avisad[oa][^.\n]*/gi;
export function notasDe(description) {
  const limpio = sinHtml(description);
  const avisos = limpio.match(RX_AVISO) || [];
  return avisos.join(" | ").trim();
}

// Asignacion automatica (orden de prioridad fijo).
export function asignadoDe(texto) {
  if (/inmigr/i.test(texto)) return "Mariel";
  if (/\bTT\b|tribunal de trabajo|\bT\.?\s*\d+\s*(LZ|AV)\b/i.test(texto)) return "Soledad";
  if (/avellaneda|lan[uú]s|\bAV\b|\bLN\b/i.test(texto)) return "David";
  return "";
}

/** Marca "⚠ CHOQUE" en ambas filas cuando dos audiencias del mismo dia se superponen. */
export function marcarChoques(filas) {
  for (let i = 0; i < filas.length; i++) {
    for (let j = i + 1; j < filas.length; j++) {
      const a = filas[i], b = filas[j];
      if (a.fecha !== b.fecha) continue;
      const solapan = a.inicio < b.fin && b.inicio < a.fin;
      if (solapan) {
        if (!/CHOQUE/.test(a.notas)) a.notas = ["⚠ CHOQUE", a.notas].filter(Boolean).join(" | ");
        if (!/CHOQUE/.test(b.notas)) b.notas = ["⚠ CHOQUE", b.notas].filter(Boolean).join(" | ");
      }
    }
  }
  return filas;
}

/** Arma la fila completa (Dia/Fecha/Hora/Caratula/Tipo/Modalidad/Lugar/Link/Asignado/Notas) de un evento crudo. */
export function clasificar(ev) {
  const textoCompleto = `${ev.summary} ${ev.description} ${ev.location}`;
  return {
    dia: diaDe(ev.inicio), fecha: fechaDDMM(ev.inicio), hora: horaHHMM(ev.inicio),
    caratula: sinHtml(ev.summary).trim(),
    tipo: tipoDe(textoCompleto),
    modalidad: modalidadDe(textoCompleto),
    lugar: lugarDe(ev.location, ev.summary),
    link: linkDe(ev.description),
    asignado: asignadoDe(textoCompleto),
    notas: notasDe(ev.description),
    inicio: ev.inicio, fin: ev.fin || ev.inicio,
  };
}
