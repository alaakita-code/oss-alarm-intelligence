// workers/lib/normalize.js
// 純函式：CSV/webhook 告警正規化。不含任何 I/O（無 fetch、無 DB、無 R2）。
// 對應 AC-1 驗收條件：正規化為純函式，可離線單元測試。

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
 * 正規化單筆告警原始資料。
 * @param {Object} rawRow - 至少含 site_id, alarm_type/description, severity, timestamp
 * @returns {Object} { ok: true, alarm: {...} } 或 { ok: false, error: string }
 */
function normalizeAlarmRow(rawRow) {
  if (!rawRow || typeof rawRow !== 'object') {
    return { ok: false, error: '非物件格式' };
  }

  var siteId = (rawRow.site_id || rawRow.site || rawRow['站點代碼'] || '').toString().trim();
  if (!siteId) {
    return { ok: false, error: '缺少 site_id' };
  }

  var text = (rawRow.description || rawRow.alarm_type || rawRow['告警類型'] || rawRow['描述'] || '').toString().trim();
  if (!text) {
    return { ok: false, error: '缺少告警描述文字' };
  }

  var ts = parseTimestamp(rawRow.timestamp || rawRow.time || rawRow['時間']);
  if (ts === null) {
    return { ok: false, error: '時間格式無法解析: ' + (rawRow.timestamp || rawRow.time || rawRow['時間']) };
  }

  var severity = normalizeSeverity(rawRow.severity || rawRow['嚴重度']);

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

module.exports = {
  normalizeSeverity: normalizeSeverity,
  parseTimestamp: parseTimestamp,
  normalizeAlarmRow: normalizeAlarmRow,
  normalizeAlarmBatch: normalizeAlarmBatch
};
