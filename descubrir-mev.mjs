#!/usr/bin/env node
/**
 * descubrir-mev.mjs - Diagnostico + siembra manual de la cartera MEV (SCBA).
 *
 * Corre una vez (o cuando quieras revisar el estado): loguea, recorre las
 * jurisdicciones de MEV_JURISDICCIONES, lista sus sets y las causas de cada
 * uno, y siembra cartera-mev.xlsx. Sirve para confirmar credenciales/endpoints
 * antes de programar el parte, y para ver que trae cada set.
 *
 * Uso:  node descubrir-mev.mjs
 * Config: ver .env.mev.example (MEV_USUARIO, MEV_CLAVE, MEV_JURISDICCIONES).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { entrarJurisdiccion, causasDeSet, buscarPorCaratula, listarDeptos, endpointsEnUso, PAUSA } from "./lib/mev-client.mjs";
import { hayCredenciales, configAuth, login } from "./lib/mev-auth.mjs";
import { upsertCausas, filasPlanillaPendientes, eliminarStubs } from "./lib/cartera-mev.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(function cargarEnv() {
  const envPath = path.resolve(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const linea of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

// ─── busqueda activa por actor+demandado (para lo que la planilla conoce y el ──
// barrido de sets autorizados no encontro) ─────────────────────────────────────
// OJO: el "NUMERO" de la planilla NO es el numero de expediente/receptoria real de
// la MEV (confirmado en vivo: buscar por numero trajo una causa de OTRO año con el
// mismo numero). Por eso esto busca por CARATULA (actor, cruzado con demandado para
// confirmar), no por numero.
const normLibre = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim();
const STOP_NOMBRE = new Set(["de", "del", "la", "las", "los", "y", "otro", "otros", "otra", "otras", "sa", "srl", "sac", "sacyf", "sociedad", "anonima", "municipalidad", "compania", "empresa"]);
// OJO: NO usar "la palabra mas larga" como clave de busqueda — un nombre de pila
// largo (ej. "ZAPATA DANIEL ESTEBAN") le gana en longitud al apellido real
// ("ESTEBAN" vs "ZAPATA") y termina buscando por el nombre de pila, que puede
// matchear una persona totalmente distinta. Confirmado en vivo: asi se genero un
// match incorrecto. La planilla SIEMPRE trae "APELLIDO Nombre(s)" primero: usar la
// primera palabra (salteando conectores/entidades geneticas de la stoplist).
function palabraClave(nombre) {
  const palabras = normLibre(nombre).split(" ").filter((w) => w.length >= 3 && !STOP_NOMBRE.has(w));
  return palabras[0] || normLibre(nombre).split(" ")[0] || "";
}
function resolverOrganismo(organismos, fuero, tribunal) {
  if (!tribunal) return null;
  const rxFuero = /laboral/i.test(fuero) ? /tribunal de trabajo/i
    : /cont\.?\s*adm/i.test(fuero) ? /contencioso administrativo/i
    : /civil y comercial/i;
  return organismos.find((o) => rxFuero.test(o.nombre) && (o.nombre.match(/(\d+)\s*$/) || [])[1] === String(Number(tribunal))) || null;
}

async function buscarPlanillaEnPortal() {
  const pendientes = await filasPlanillaPendientes();
  if (!pendientes.length) return { encontradas: 0, sinOrganismo: 0, noEncontradas: [], ambiguas: [] };
  console.log(`\nBusqueda activa por actor+demandado: ${pendientes.length} causa(s) de la planilla sin confirmar en el portal.`);

  const porDepto = new Map();
  for (const f of pendientes) { if (!porDepto.has(f.depto)) porDepto.set(f.depto, []); porDepto.get(f.depto).push(f); }

  let encontradas = 0, sinOrganismo = 0;
  const noEncontradas = [], ambiguas = [];

  for (const [depto, filas] of porDepto) {
    let organismos;
    try {
      const r = await entrarJurisdiccion({ depto });
      organismos = r.organismos;
    } catch (e) {
      console.log(`  [${depto}] no se pudo entrar a la jurisdiccion: ${e.message}`);
      for (const f of filas) noEncontradas.push({ ...f, motivo: `jurisdiccion "${depto}": ${e.message}` });
      continue;
    }
    for (const f of filas) {
      const org = resolverOrganismo(organismos, f.fuero, f.tribunal);
      if (!org) { sinOrganismo++; noEncontradas.push({ ...f, motivo: "no se encontro el organismo (fuero/tribunal)" }); continue; }
      await sleep(PAUSA);
      let resultado;
      try {
        resultado = await buscarPorCaratula({ depto }, org.valor, palabraClave(f.actor));
      } catch (e) {
        noEncontradas.push({ ...f, motivo: `busqueda fallo: ${e.message}` }); continue;
      }
      // "Beneficio de litigar sin gastos" es un incidente APARTE de la causa principal
      // en la MEV, con su propio nidCausa, y su caratula tipicamente NO menciona al
      // demandado (solo "ACTOR S/ BENEFICIO..."). Si no distinguimos esto, una busqueda
      // por actor+demandado para el incidente termina matcheando por error la causa
      // principal (mismo actor, aparece primero, "pasa" el filtro de nada). Por eso:
      // - materia "beneficio" -> filtrar por la palabra "beneficio" en la caratula.
      // - materia normal -> exigir el demandado Y excluir cualquier resultado que diga
      //   "beneficio" (para no terminar matcheando el incidente en el sentido inverso).
      //
      // OJO 2 (confirmado en vivo con un segundo falso positivo): NO alcanza con que
      // las dos palabras aparezcan en algun lado de la caratula. Alguien con apellido
      // compuesto ("MALDONADO AGUIRRE MATIAS") puede contener el apellido del actor
      // buscado ("AGUIRRE") Y el del demandado buscado ("MALDONADO") en SU PROPIO
      // nombre, del lado del actor, sin que el demandado real tenga nada que ver. Por
      // eso hay que partir la caratula en la parte de ANTES y DESPUES de "C/" real, y
      // exigir que el apellido del actor este del lado de antes y el del demandado del
      // lado de despues — no en cualquier lado.
      const esBeneficio = /beneficio/i.test(f.materia);
      const claveAct = palabraClave(f.actor);
      const claveDem = palabraClave(f.demandado);
      const candidatos = resultado.causas.filter((c) => {
        const m = c.caratula.match(/^(.*?)\bc\/(.*)$/i);
        const parteActor = normLibre(m ? m[1] : c.caratula);
        const parteResto = normLibre(m ? m[2] : c.caratula);
        if (!parteActor.includes(claveAct)) return false; // el actor buscado tiene que estar del lado del actor
        if (esBeneficio) return normLibre(c.caratula).includes("beneficio");
        if (normLibre(c.caratula).includes("beneficio")) return false;
        return claveDem && parteResto.includes(claveDem); // el demandado, del lado de despues de "C/"
      });
      if (candidatos.length === 1) {
        const c = candidatos[0];
        // actor/demandado/materia/firma: los sabemos por la planilla (son los que
        // usamos para buscar) — el "Nro Expediente" real de la MEV no coincide con el
        // NUMERO de la planilla (ver nota arriba), asi que el cruce normal de
        // aplicarPlanilla no va a poder completarlos despues: hay que pasarlos aca.
        await upsertCausas({ causas: [{
          nidCausa: c.nidCausa, pidJuzgado: c.pidJuzgado, organismo: org.nombre, jurisdiccion: depto,
          caratula: c.caratula, estado: c.estado, expediente: c.expediente, receptoria: c.receptoria,
          fechaInicio: c.fechaInicio, ultimoMovimiento: c.ultimoMovimiento,
          actor: f.actor, demandado: f.demandado, materia: f.materia, firma: f.firma,
        }] });
        // Borra el stub AL TOQUE (no en lote al final): si el proceso se corta a mitad
        // de camino, lo ya confirmado queda bien y no se duplica en el proximo intento.
        await eliminarStubs([f.nidStub]);
        encontradas++;
        console.log(`  [OK] ${f.actor} c/ ${f.demandado} (${f.materia}) -> ${c.caratula} (nidCausa ${c.nidCausa})`);
      } else if (candidatos.length > 1) {
        ambiguas.push({ ...f, candidatos: candidatos.length });
      } else {
        noEncontradas.push({ ...f, motivo: `sin match para "${esBeneficio ? "beneficio" : claveDem}" entre ${resultado.causas.length} resultado(s) de "${palabraClave(f.actor)}"` });
      }
    }
  }

  return { encontradas, sinOrganismo, noEncontradas, ambiguas };
}

function parseJurisdicciones(lista) {
  return lista.map((s) => {
    const partes = s.split(":").map((x) => x.trim()).filter(Boolean);
    return { clave: s, depto: partes[0], penal: partes.slice(1).map((x) => x.toLowerCase()).includes("penal"), familia: partes.slice(1).map((x) => x.toLowerCase()).includes("familia") };
  });
}

// Modo AUTO: barre los 23 departamentos x fuero (civil / familia / penal). Usa el
// valor numerico de DtoJudElegido (evita resolver por nombre) y arma una clave legible.
async function jurisdiccionesAuto() {
  await login();
  const deptos = await listarDeptos();
  if (!deptos.length) throw new Error("no se pudieron listar los departamentos (POSloguin vino vacio)");
  // La clave se guarda como jurisdiccion en la cartera y debe ser RE-PARSEABLE por
  // el parte (formato "Depto:penal" / "Depto:familia" / "Depto"), no una etiqueta libre.
  const jurs = [];
  for (const d of deptos) {
    jurs.push({ clave: d.nombre, depto: d.valor });
    jurs.push({ clave: `${d.nombre}:familia`, depto: d.valor, familia: true });
    jurs.push({ clave: `${d.nombre}:penal`, depto: d.valor, penal: true });
  }
  return jurs;
}

async function main() {
  console.log("Config auth:", configAuth());
  console.log("Endpoints:", endpointsEnUso());
  if (!hayCredenciales()) { console.error("\nFaltan MEV_USUARIO/MEV_CLAVE en .env. La MEV no tiene consulta anonima."); process.exit(1); }

  const rawJur = (process.env.MEV_JURISDICCIONES || "").trim();
  const auto = rawJur === "" || rawJur.toLowerCase() === "auto";
  let jurs;
  if (auto) {
    console.log("\nMODO AUTO: barriendo todos los departamentos x fuero (esto tarda un poco)...");
    jurs = await jurisdiccionesAuto();
    console.log(`  ${jurs.length} jurisdicciones a recorrer.`);
  } else {
    jurs = parseJurisdicciones(rawJur.split(";").map((s) => s.trim()).filter(Boolean));
  }

  const pausa = Number(process.env.MEV_PAUSA_MS || PAUSA);
  let totalSembradas = 0, totalCausas = 0, jurConCausas = 0, i = 0;
  const conCausas = [];
  for (const jur of jurs) {
    i++;
    if (!auto) console.log(`\n=== Jurisdiccion: ${jur.clave} ===`);
    else process.stdout.write(`\r  [${i}/${jurs.length}] ${jur.clave.padEnd(34).slice(0, 34)}`);
    try {
      await sleep(pausa);
      const { organismos, sets } = await entrarJurisdiccion(jur);
      if (!auto) {
        console.log(`  Organismos disponibles: ${organismos.length}`);
        console.log(`  Sets: ${sets.length ? sets.map((s) => `${s.nombre} (nidset ${s.nidset})`).join(" | ") : "(ninguno)"}`);
      }
      const orgPorJuz = new Map(organismos.map((o) => [o.valor.trim(), o.nombre]));
      let causasJur = 0;
      for (const set of sets) {
        await sleep(pausa);
        const r = await causasDeSet(jur, set.nidset);
        if (r.sinResultados) { if (!auto) console.log(`    Set "${set.nombre}": sin causas en esta jurisdiccion.`); continue; }
        causasJur += r.causas.length;
        if (!auto) {
          console.log(`    Set "${set.nombre}": ${r.causas.length} causa(s)${r.total != null ? ` (total ${r.total})` : ""}`);
          for (const c of r.causas.slice(0, 10)) console.log(`      - ${c.expediente || c.nidCausa} | ${c.caratula} | ${c.estado} | ult: ${c.ultimoMovimiento.fecha} ${c.ultimoMovimiento.descripcion}`);
        }
        const causas = r.causas.map((c) => ({ ...c, jurisdiccion: jur.clave, organismo: orgPorJuz.get(String(c.pidJuzgado).trim()) || "" }));
        const up = await upsertCausas({ causas });
        totalSembradas += up.nuevas || 0;
        if (!auto) console.log(`      -> cartera: ${up.nuevas || 0} nueva(s), ${up.total || 0} total.`);
      }
      if (causasJur > 0) {
        totalCausas += causasJur; jurConCausas++; conCausas.push({ clave: jur.clave, causasJur });
        if (auto) process.stdout.write(`\r  [${i}/${jurs.length}] ${jur.clave}: ${causasJur} causa(s)\n`);
      }
    } catch (e) {
      if (auto) process.stdout.write(`\r  [${i}/${jurs.length}] ${jur.clave}: ERROR ${e.message}\n`);
      else console.error(`  ERROR en ${jur.clave}: ${e.message}`);
      if (e.claveVencida) { console.error("\n  >>> La clave MEV esta vencida: renovarla a mano en mev.scba.gov.ar (cambio forzado cada 90 dias)."); break; }
    }
  }
  if (auto) {
    process.stdout.write("\r".padEnd(60) + "\r");
    console.log(`\nJurisdicciones con causas (${jurConCausas}):`);
    for (const j of conCausas.sort((a, b) => b.causasJur - a.causasJur)) console.log(`  - ${j.clave}: ${j.causasJur}`);
    console.log(`\nSugerencia: para el parte diario, poné en MEV_JURISDICCIONES solo esas jurisdicciones`);
    console.log(`(formato Depto[:penal][:familia], separadas por ";"), así el bot no barre las 69 cada dia.`);
  }
  console.log(`\nListo. ${totalCausas} causa(s) vistas, ${totalSembradas} nueva(s) sembrada(s) en cartera-mev.xlsx. Depura con "Vigilar"=NO.`);

  // Cruce con la planilla "LISTADO JUICIOS": actor/demandado/materia/firma + causas que
  // la planilla conoce y todavia no aparecieron en el portal.
  try {
    const { obtenerPlanilla } = await import("./lib/planilla-causas.mjs");
    const { aplicarPlanilla } = await import("./lib/cartera-mev.mjs");
    const planilla = await obtenerPlanilla();
    if (planilla.error) console.log(`Planilla: ${planilla.stale ? "usando cache anterior, " : ""}${planilla.error}`);
    const rp = await aplicarPlanilla(planilla.porSistema.MEV);
    if (rp.nota) console.log(`Planilla -> cartera: ${rp.nota}`);
    else {
      console.log(`Planilla -> cartera: ${rp.matcheadas} matcheada(s), ${rp.agregadas} agregada(s) (Vigilar=NO hasta que aparezcan en el portal).`);
      if (rp.ambiguas && rp.ambiguas.length) console.log(`Planilla -> cartera: ${rp.ambiguas.length} ambigua(s) (revisar a mano): ${rp.ambiguas.map((a) => `${a.depto} ${a.numero}`).join(", ")}`);
    }
  } catch (e) {
    console.log(`Cruce con planilla omitido: ${e.message}`);
  }

  // Busqueda activa por actor+demandado de lo que la planilla conoce y el barrido
  // de sets autorizados no encontro (ver buscarPlanillaEnPortal mas arriba).
  try {
    const rb = await buscarPlanillaEnPortal();
    if (rb.encontradas || rb.sinOrganismo || rb.noEncontradas.length || rb.ambiguas.length) {
      console.log(`Busqueda activa: ${rb.encontradas} encontrada(s), ${rb.sinOrganismo} sin organismo resuelto, ${rb.noEncontradas.length} sin match, ${rb.ambiguas.length} ambigua(s).`);
      if (rb.ambiguas.length) console.log(`  Ambiguas (revisar a mano): ${rb.ambiguas.map((a) => `${a.actor} c/ ${a.demandado} (${a.candidatos} candidatos)`).join(" | ")}`);
      if (rb.noEncontradas.length) console.log(`  Sin match: ${rb.noEncontradas.map((a) => `${a.actor} c/ ${a.demandado}`).join(" | ")}`);
    }
  } catch (e) {
    console.log(`Busqueda activa por planilla omitida: ${e.message}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
