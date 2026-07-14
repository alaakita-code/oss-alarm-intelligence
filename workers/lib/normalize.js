// workers/lib/normalize.js
// 純函式：CSV/webhook 告警正規化。不含任何 I/O（無 fetch、無 DB、無 R2）。
// 對應 AC-1 驗收條件：正規化為純函式，可離線單元測試。
//
// 欄位比對為「不分大小寫」：Site_ID / SITE_ID / site_id 皆視為同一欄位，
// 以相容不同系統匯出的CSV大小寫習慣（英文欄位比對不分大小寫；
// 中文欄位如「站點代碼」本身無大小寫問題，不受影響）。

var SEVERITY_MAP = {
  'critical': 'critical', 'crit': 'critical', '緊急': 'critical', '嚴重': 'critical',
  'major': 'major', '主要': 'major', '重大': 'major',
  'minor': 'minor', '次要': 'minor',
  'warning': 'warning', 'warn': 'warning', '警告': 'warning'
};

function normalizeSeverity(raw) {
  if (!raw) return 'warning';
  var key = String(raw).trim().toLowerCase();
  return SEVERITY_MAP[key] || 'warning';
}

function parseTimestamp(raw) {
  // 接受 ISO8601 字串或 unix 秒數字串，統一轉為 unix 秒數（整數）
  if (raw === null || raw === undefined || raw === '') return null;
  if (/^\d+$/.test(String(raw).trim())) {
    var n = parseInt(raw, 10);
    // 判斷是毫秒還是秒（13位視為毫秒）
    return n >= 1e12 ? Math.floor(n / 1000) : n;
  }
  var d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000);
}

/**
 * 將一列原始資料的所有欄位key轉成小寫，建立比對用的查詢表。
 * 中文key（如「站點代碼」）toLowerCase()對其無作用，不受影響。
 * @param {Object} rawRow
 * @returns {Object} 小寫key -> 原始值
 */
function buildLowerKeyMap(rawRow) {
  var map = {};
  var keys = Object.keys(rawRow);
  for (var i = 0; i < keys.length; i++) {
    map[keys[i].toLowerCase()] = rawRow[keys[i]];
  }
  return map;
}

/**
 * 依候選欄位名稱清單（依序嘗試），從小寫查詢表取出第一個非空值。
 * @param {Object} lowerMap - buildLowerKeyMap 產生的查詢表
 * @param {Array<string>} candidates - 候選欄位名稱（不分大小寫比對）
 * @returns {*} 找到的值，找不到則回傳空字串
 */
function pickField(lowerMap, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    var v = lowerMap[candidates[i].toLowerCase()];
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      return v;
    }
  }
  return '';
}

/**
 * 正規化單筆告警原始資料。
 * @param {Object} rawRow - 至少含 site_id, alarm_type/description, severity, timestamp（欄位名稱不分大小寫）
 * @returns {Object} { ok: true, alarm: {...} } 或 { ok: false, error: string }
 */
function normalizeAlarmRow(rawRow) {
  if (!rawRow || typeof rawRow !== 'object') {
    return { ok: false, error: '非物件格式' };
  }

  var lowerMap = buildLowerKeyMap(rawRow);

  var siteId = String(pickField(lowerMap, ['site_id', 'site', '站點代碼'])).trim();
  if (!siteId) {
    return { ok: false, error: '缺少 site_id' };
  }

  var text = String(pickField(lowerMap, ['description', 'alarm_type', '告警類型', '描述'])).trim();
  if (!text) {
    return { ok: false, error: '缺少告警描述文字' };
  }

  var tsRaw = pickField(lowerMap, ['timestamp', 'time', '時間']);
  var ts = parseTimestamp(tsRaw);
  if (ts === null) {
    return { ok: false, error: '時間格式無法解析: ' + tsRaw };
  }

  var severity = normalizeSeverity(pickField(lowerMap, ['severity', '嚴重度']));

  return {
    ok: true,
    alarm: {
      site_id: siteId,
      raw_text: text,
      severity: severity,
      ts: ts
    }
  };
}

/**
 * 批次正規化。回傳 { normalized: [...], errors: [...] }
 * errors 為 { row_index, error } 陣列。
 */
function normalizeAlarmBatch(rawRows) {
  var normalized = [];
  var errors = [];
  for (var i = 0; i < rawRows.length; i++) {
    var result = normalizeAlarmRow(rawRows[i]);
    if (result.ok) {
      normalized.push(result.alarm);
    } else {
      errors.push({ row_index: i, error: result.error });
    }
  }
  return { normalized: normalized, errors: errors };
}

export {
  normalizeSeverity,
  parseTimestamp,
  normalizeAlarmRow,
  normalizeAlarmBatch
};
