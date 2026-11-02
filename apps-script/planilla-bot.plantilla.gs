/**
 * monitor-judicial-ar — puente entre el bot y la planilla LISTADO JUICIOS.
 *
 * Instalacion (una sola vez):
 *  1. En la planilla: Extensiones > Apps Script. Borrar lo que haya y pegar TODO este archivo.
 *  2. Guardar (icono de disquete).
 *  3. Implementar > Nueva implementacion > tipo "Aplicacion web".
 *     Ejecutar como: "Yo".  Quien tiene acceso: "Cualquier usuario".
 *  4. Autorizar con tu cuenta de Google (avisa "app no verificada": Avanzado > Ir a ...).
 *  5. Copiar la URL de la aplicacion web y pasarsela a Claude.
 *
 * Seguridad: sin el TOKEN de abajo no lee ni escribe nada. El TOKEN solo esta aca y
 * en el .env del servidor.
 */
var TOKEN = 'PEGAR_TOKEN_AQUI';
var COLUMNAS_BOT = ['VIGILAR', 'CADUCIDAD', 'ULT. IMPULSO', 'FIRMA'];

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// GET ?token=... -> todas las pestañas con sus valores tal como se ven.
function doGet(e) {
  if (!e || !e.parameter || e.parameter.token !== TOKEN) return json_({ error: 'token invalido' });
  var hojas = SpreadsheetApp.getActive().getSheets().map(function (sh) {
    var rango = sh.getDataRange();
    return { nombre: sh.getName(), gid: sh.getSheetId(), valores: rango.getDisplayValues() };
  });
  return json_({ ok: true, hojas: hojas });
}

// Busca la fila de encabezados (primeras 6 filas) y devuelve { fila, cols: {NOMBRE: n} }.
function encabezados_(sh) {
  var v = sh.getRange(1, 1, Math.min(6, sh.getMaxRows()), sh.getLastColumn()).getDisplayValues();
  for (var r = 0; r < v.length; r++) {
    var cols = {};
    v[r].forEach(function (h, i) { if (h) cols[String(h).trim().toUpperCase()] = i + 1; });
    if (cols['NUMERO'] && (cols['VIGILAR'] || cols['CADUCIDAD'])) return { fila: r + 1, cols: cols };
  }
  return null;
}

// POST {token, cambios:[{hoja, fila, columna, valor, tipo, nota}]}
//   tipo "sugerencia": texto gris en cursiva (el bot la usa recien cuando le sacas el "?")
//   tipo "aplicado":   texto normal (el bot ya lo esta usando), con nota explicativa
function doPost(e) {
  var body = JSON.parse(e.postData.contents || '{}');
  if (body.token !== TOKEN) return json_({ error: 'token invalido' });
  var ss = SpreadsheetApp.getActive();
  var hechos = 0, errores = [];
  (body.cambios || []).forEach(function (c) {
    try {
      var sh = ss.getSheetByName(c.hoja);
      if (!sh) throw new Error('no existe la pestaña ' + c.hoja);
      var h = encabezados_(sh);
      if (!h) throw new Error('sin encabezados en ' + c.hoja);
      var col = h.cols[String(c.columna).toUpperCase()];
      if (!col || COLUMNAS_BOT.indexOf(String(c.columna).toUpperCase()) < 0) throw new Error('columna no permitida: ' + c.columna);
      if (c.fila <= h.fila) throw new Error('fila invalida ' + c.fila);
      var cel = sh.getRange(c.fila, col);
      cel.setValue(c.valor);
      if (c.tipo === 'sugerencia') cel.setFontColor('#888888').setFontStyle('italic');
      else cel.setFontColor(null).setFontStyle('normal');
      if (c.nota) cel.setNote(c.nota);
      hechos++;
    } catch (err) { errores.push(String(err.message || err)); }
  });
  return json_({ ok: true, hechos: hechos, errores: errores });
}

// Cuando editas a mano una de las columnas del bot, el texto vuelve a verse normal.
function onEdit(e) {
  try {
    var sh = e.range.getSheet(), h = encabezados_(sh);
    if (!h || e.range.getRow() <= h.fila) return;
    var nombre = Object.keys(h.cols).filter(function (k) { return h.cols[k] === e.range.getColumn(); })[0];
    if (COLUMNAS_BOT.indexOf(nombre) >= 0) e.range.setFontColor(null).setFontStyle('normal');
  } catch (err) {}
}
