/**
 * Carga unica: pasa la copia exportada de Supabase (tabla casos) al almacen propio
 * (data/casos.json). Uso: node importar-export-supabase.mjs <archivo.json>
 * No toca Supabase. Conserva las novedades ya registradas y cruza el origen con la planilla.
 */
import fs from "node:fs";
import { sincronizarCasosLocal, rutaStore } from "./lib/casos-local.mjs";
import { obtenerPlanilla } from "./lib/planilla-causas.mjs";

const archivo = process.argv[2];
if (!archivo) { console.error("Uso: node importar-export-supabase.mjs <casos.json>"); process.exit(1); }
const filas = JSON.parse(fs.readFileSync(archivo, "utf8"));
const DEPTOS = { lz: "Lomas de Zamora", ql: "Quilmes" };

const planilla = (await obtenerPlanilla()).filas || [];
const por = { PJN: [], MEV: [] };
for (const f of filas) {
  const m = String(f.id).match(/^(pjn|mev)-([a-z0-9]*)-(\d+)-(.+)$/);
  if (!m) { console.log("id no reconocido, se omite:", f.id); continue; }
  const inc = (String(f.caratula || "").match(/^\s*incidente\s*n[ºo°]?\.?\s*(\d+)/i) || [])[1] || null;
  const base = {
    numero: f.numero, inc, anio: m[4] === "s-a" ? null : m[4],
    caratula: f.caratula, actor: f.actor, demandado: f.demandado, materia: f.materia,
    firma: f.firma, juzgado: f.juzgado, estado: f.estado,
    ultimaActuacion: f.data?.ultimaActuacion || null,
    novedadesNuevas: Array.isArray(f.data?.novedades) ? f.data.novedades : [],
  };
  if (f.sistema === "PJN") {
    // Algunas filas viejas tienen el fuero vacio en el id: se toma de la planilla por numero.
    const fuero = m[2].toUpperCase() || (planilla.find((x) => x.sistema === "PJN" && Number(x.numero) === Number(f.numero)) || {}).fuero || "";
    por.PJN.push({ ...base, fuero });
  }
  else por.MEV.push({ ...base, depto: DEPTOS[m[2]] || m[2] });
}
for (const sistema of ["PJN", "MEV"]) {
  const r = await sincronizarCasosLocal({ sistema, causas: por[sistema] });
  console.log(sistema, "planilla sin causa:", r.planillaSinCausa.join(", "), "| desestimadas:", r.descartadas.join(", "), "| creados", r.creados, "actualizados", r.actualizados, "sin origen", r.sinOrigen.length, r.sinOrigen.join(", "));
}
console.log("Almacen:", rutaStore());
