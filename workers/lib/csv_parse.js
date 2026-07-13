// workers/lib/csv_parse.js
// 純函式：CSV 文字 → 物件陣列。不含任何 I/O。
// 手刻極簡 CSV parser（不依賴外部套件，符合零依賴精神），支援雙引號跳脫。

function parseCsvText(text) {
  var rows = [];
  var i = 0;
  var len = text.length;
  var field = '';
  var row = [];
  var inQuotes = false;

  function pushField() {
    row.push(field);
    field = '';
  }
  function pushRow() {
    pushField();
    rows.push(row);
    row = [];
  }

  while (i < len) {
    var c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }

    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { pushField(); i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { pushRow(); i++; continue; }
    field += c; i++;
  }
  // 最後一行（若無結尾換行）
  if (field.length > 0 || row.length > 0) pushRow();

  return rows;
}

/**
 * CSV 文字 → 物件陣列（以第一行為 header）
 * @returns {Array<Object>}
 */
function csvTextToObjects(text) {
  var rows = parseCsvText(text);
  if (rows.length === 0) return [];
  var header = rows[0];
  var result = [];
  for (var r = 1; r < rows.length; r++) {
    var row = rows[r];
    if (row.length === 1 && row[0] === '') continue; // 跳過空行
    var obj = {};
    for (var c = 0; c < header.length; c++) {
      obj[header[c]] = row[c] !== undefined ? row[c] : '';
    }
    result.push(obj);
  }
  return result;
}

module.exports = {
  parseCsvText: parseCsvText,
  csvTextToObjects: csvTextToObjects
};
