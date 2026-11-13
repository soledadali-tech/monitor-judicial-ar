#!/usr/bin/env node
/** Imprime en JSON las conversaciones de los ultimos N dias (por defecto 30). Solo lectura. */
import { conversaciones } from "./util.mjs";
console.log(JSON.stringify(conversaciones(Number(process.argv[2]) || 30)));
