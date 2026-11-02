/**
 * salida-parte.mjs - Modo "parte combinado" (nov-2026).
 *
 * Si SALIDA_DIR esta definida, los partes de cada frente (PJN, MEV) NO mandan su
 * propio mail: dejan un JSON con asunto/flags, texto, html y adjuntos en esa carpeta.
 * parte-combinado.mjs los junta en UN solo mail diario. Sin SALIDA_DIR todo sigue
 * igual que antes (cada script manda su mail).
 */
import fs from "node:fs";
import path from "node:path";

export function modoCombinado() { return !!process.env.SALIDA_DIR; }

export function guardarSalida(frente, datos) {
  const dir = process.env.SALIDA_DIR;
  if (!dir) return false;
  fs.mkdirSync(dir, { recursive: true });
  const adjuntos = (datos.adjuntos || []).map((a) => ({
    filename: a.filename,
    contentType: a.contentType || undefined,
    base64: a.content != null ? Buffer.from(a.content).toString("base64") : undefined,
    path: a.path || undefined,
  }));
  fs.writeFileSync(path.join(dir, `parte-${frente.toLowerCase()}.json`), JSON.stringify({ ...datos, frente, adjuntos }));
  return true;
}

export function leerSalida(dir, frente) {
  const p = path.join(dir, `parte-${frente.toLowerCase()}.json`);
  if (!fs.existsSync(p)) return null;
  const d = JSON.parse(fs.readFileSync(p, "utf8"));
  d.adjuntos = (d.adjuntos || []).map((a) => (a.base64 ? { filename: a.filename, contentType: a.contentType, content: Buffer.from(a.base64, "base64") } : { filename: a.filename, contentType: a.contentType, path: a.path }));
  return d;
}
