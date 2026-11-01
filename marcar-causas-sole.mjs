// Marca causas en cartera-mev.xlsx segun indicacion de Sole (01/11/2026). Uso: node marcar.mjs <xlsx>
import ExcelJS from "exceljs";
const archivo = process.argv[2];
const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(archivo);
const ws = wb.worksheets.find((w) => /causa|exped/i.test(w.name)) || wb.worksheets[0];
const col = {}; ws.getRow(1).eachCell((c, i) => { col[c.text.trim()] = i; });
const reglas = [
  { rx: /MOLINA IVANA/i, vigilar: "NO", aplica: "NO", obs: "Terminado (Sole 01/11/2026): no vigilar" },
  { rx: /PILLWEIN/i, vigilar: "NO", aplica: "NO", obs: "Terminado (Sole 01/11/2026): no vigilar" },
  { rx: /ZAPATA DANIEL/i, aplica: "EN ESPERA", obs: "En Camara, a la espera de resolucion (Sole 01/11/2026)" },
  { rx: /BIFFI YANINA/i, aplica: "EN ESPERA", obs: "En Camara, a la espera de resolucion (Sole 01/11/2026)" },
];
let n = 0;
for (let r = 2; r <= ws.rowCount; r++) {
  const row = ws.getRow(r); const car = row.getCell(col["Caratula"]).text || "";
  for (const g of reglas) if (g.rx.test(car)) {
    if (g.vigilar) row.getCell(col["Vigilar"]).value = g.vigilar;
    row.getCell(col["Caducidad Aplica"]).value = g.aplica;
    row.getCell(col["Observaciones"]).value = g.obs;
    console.log(`fila ${r}: ${car.slice(0, 60)} -> ${g.vigilar ? "Vigilar=" + g.vigilar + ", " : ""}Caducidad Aplica=${g.aplica}`); n++;
  }
}
await wb.xlsx.writeFile(archivo); console.log(`${n} fila(s) marcadas`);
