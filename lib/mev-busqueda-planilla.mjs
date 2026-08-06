/**
 * mev-busqueda-planilla.mjs - Busqueda activa en el portal MEV de las causas que la
 * planilla "LISTADO JUICIOS" conoce (depto+organismo+numero) pero que el barrido de
 * sets "autorizados" no encontro (no estan vinculadas a este login MEV).
 *
 * Usado por descubrir-mev.mjs (corrida manual) y por parte-diario-mev.mjs (corrida
 * diaria automatica), asi que vive en lib/ en vez de en el script de descubrimiento.
 *
 * El "NUMERO" de la planilla SI es el "Número de Expediente" real de la MEV
 * (radio=xNc, campo NCausa) — confirmado en vivo por la usuaria buscando a mano en
 * el portal con 4 causas que este bot no habia podido resolver, las 4 aparecieron
 * con ese numero exacto. Por eso la busqueda por numero va PRIMERO (mas precisa y
 * rapida). Igual se valida el actor contra la caratula del resultado antes de
 * aceptarlo: en un caso puntual anterior el numero de la planilla estaba mal cargado
 * y devolvio una causa de otro año que nada tenia que ver — sin esa validacion se
 * hubiera guardado mal. Si la busqueda por numero no da un resultado valido, cae a la
 * busqueda por CARATULA (actor, cruzado con demandado) como respaldo.
 */
import { entrarJurisdiccion, buscarPorCaratula, buscarPorNumero, PAUSA } from "./mev-client.mjs";
import { upsertCausas, filasPlanillaPendientes, eliminarStubs } from "./cartera-mev.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/**
 * Corre la busqueda activa sobre TODOS los stubs pendientes de la planilla.
 * Devuelve { encontradas, sinOrganismo, noEncontradas:[{...fila,motivo}], ambiguas:[{...fila,candidatos}] }.
 * Efecto secundario: escribe en cartera-mev.xlsx (upsertCausas + eliminarStubs) por
 * cada causa que resuelve.
 */
export async function buscarPlanillaEnPortal({ log = () => {} } = {}) {
  const pendientes = await filasPlanillaPendientes();
  if (!pendientes.length) return { encontradas: 0, sinOrganismo: 0, noEncontradas: [], ambiguas: [] };
  log(`\nBusqueda activa: ${pendientes.length} causa(s) de la planilla sin confirmar en el portal.`);

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
      log(`  [${depto}] no se pudo entrar a la jurisdiccion: ${e.message}`);
      for (const f of filas) noEncontradas.push({ ...f, motivo: `jurisdiccion "${depto}": ${e.message}` });
      continue;
    }
    for (const f of filas) {
      const org = resolverOrganismo(organismos, f.fuero, f.tribunal);
      if (!org) { sinOrganismo++; noEncontradas.push({ ...f, motivo: "no se encontro el organismo (fuero/tribunal)" }); continue; }

      // "Beneficio de litigar sin gastos" es un incidente APARTE de la causa principal
      // en la MEV, con su propio nidCausa, y su caratula tipicamente NO menciona al
      // demandado (solo "ACTOR S/ BENEFICIO..."). Si no distinguimos esto, una busqueda
      // por actor+demandado para el incidente termina matcheando por error la causa
      // principal (mismo actor, aparece primero, "pasa" el filtro de nada). Por eso:
      // - materia "beneficio" -> filtrar por la palabra "beneficio" en la caratula.
      // - materia normal -> exigir el demandado Y excluir cualquier resultado que diga
      //   "beneficio" (para no terminar matcheando el incidente en el sentido inverso).
      //
      // OJO (confirmado en vivo con un falso positivo): NO alcanza con que las dos
      // palabras aparezcan en algun lado de la caratula. Alguien con apellido compuesto
      // ("MALDONADO AGUIRRE MATIAS") puede contener el apellido del actor buscado
      // ("AGUIRRE") Y el del demandado buscado ("MALDONADO") en SU PROPIO nombre, del
      // lado del actor, sin que el demandado real tenga nada que ver. Por eso hay que
      // partir la caratula en la parte de ANTES y DESPUES de "C/" real, y exigir que el
      // apellido del actor este del lado de antes y el del demandado del lado de
      // despues — no en cualquier lado.
      const esBeneficio = /beneficio/i.test(f.materia);
      const claveAct = palabraClave(f.actor);
      const claveDem = palabraClave(f.demandado);
      // Validacion completa (actor Y demandado, cada uno de su lado de "C/"): para la
      // busqueda por CARATULA, que puede traer decenas de resultados y necesita las dos
      // señales para desambiguar.
      const valida = (c) => {
        const m = c.caratula.match(/^(.*?)\bc\/(.*)$/i);
        const parteActor = normLibre(m ? m[1] : c.caratula);
        const parteResto = normLibre(m ? m[2] : c.caratula);
        if (!parteActor.includes(claveAct)) return false; // el actor buscado tiene que estar del lado del actor
        if (esBeneficio) return normLibre(c.caratula).includes("beneficio");
        if (normLibre(c.caratula).includes("beneficio")) return false;
        return claveDem && parteResto.includes(claveDem); // el demandado, del lado de despues de "C/"
      };
      // Validacion liviana (solo actor): para la busqueda por NUMERO, que ya devuelve
      // como maximo 1 causa por ese expediente puntual (no hay nada que desambiguar) —
      // exigir tambien el demandado da falsos NEGATIVOS reales: en causas de danos por
      // accidente de transito la caratula de la MEV suele citar a la ASEGURADORA
      // ("...C/ FEDERACION PATRONAL SEGUROS SA Y OTROS...") en vez del demandado
      // persona que carga la planilla (confirmado en vivo: causa de AGUIRRE, demandado
      // planilla "MALDONADO", caratula real cita a la aseguradora). El actor si se seguia
      // verificando porque un numero mal cargado en la planilla puede devolver una causa
      // de otra persona (tambien confirmado en vivo, ver nota arriba).
      const validaActor = (c) => {
        const parteActor = normLibre(c.caratula.split(/\bc\//i)[0] || c.caratula);
        if (!parteActor.includes(claveAct)) return false;
        return esBeneficio === normLibre(c.caratula).includes("beneficio");
      };

      let candidatos = [];
      let totalVistos = 0;
      let viaNumero = false;
      if (f.numeroPlanilla) {
        await sleep(PAUSA);
        try {
          const porNumero = await buscarPorNumero({ depto }, org.valor, f.numeroPlanilla);
          const cand = porNumero.causas.filter(validaActor);
          if (cand.length === 1) { candidatos = cand; viaNumero = true; }
        } catch { /* cae a busqueda por caratula */ }
      }
      if (!candidatos.length) {
        await sleep(PAUSA);
        let resultado;
        try {
          resultado = await buscarPorCaratula({ depto }, org.valor, claveAct);
        } catch (e) {
          noEncontradas.push({ ...f, motivo: `busqueda fallo: ${e.message}` }); continue;
        }
        totalVistos = resultado.causas.length;
        candidatos = resultado.causas.filter(valida);
      }
      if (candidatos.length === 1) {
        const c = candidatos[0];
        // actor/demandado/materia/firma: los sabemos por la planilla (son los que
        // usamos para buscar) — aplicarPlanilla no puede completarlos por su cuenta
        // porque la MEV recien nos confirma el numero real aca (esta fila era un
        // stub sin nidCausa hasta ahora), asi que hay que pasarlos directo.
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
        log(`  [OK${viaNumero ? " x numero" : " x caratula"}] ${f.actor} c/ ${f.demandado} (${f.materia}) -> ${c.caratula} (nidCausa ${c.nidCausa})`);
      } else if (candidatos.length > 1) {
        ambiguas.push({ ...f, candidatos: candidatos.length });
      } else {
        noEncontradas.push({ ...f, motivo: `sin match para "${esBeneficio ? "beneficio" : claveDem}" entre ${totalVistos} resultado(s) de "${claveAct}"` });
      }
    }
  }

  return { encontradas, sinOrganismo, noEncontradas, ambiguas };
}
