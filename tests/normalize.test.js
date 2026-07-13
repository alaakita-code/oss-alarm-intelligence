// tests/normalize.test.js
// 用法: node tests/normalize.test.js
var assert = require('assert');
var normalize = require('../workers/lib/normalize.js');

var passed = 0, failed = 0;
function check(desc, actual, expected) {
  var actualStr = JSON.stringify(actual);
  var expectedStr = JSON.stringify(expected);
  if (actualStr === expectedStr) {
    passed++;
  } else {
    failed++;
    console.log('  ✗ ' + desc);
    console.log('    got:      ' + actualStr);
    console.log('    expected: ' + expectedStr);
  }
}

// --- normalizeSeverity ---
check('中文嚴重度: 緊急 -> critical', normalize.normalizeSeverity('緊急'), 'critical');
check('英文嚴重度: Critical -> critical (大小寫不敏感)', normalize.normalizeSeverity('Critical'), 'critical');
check('未知嚴重度 -> 預設 warning', normalize.normalizeSeverity('foobar'), 'warning');
check('空值嚴重度 -> 預設 warning', normalize.normalizeSeverity(null), 'warning');

// --- parseTimestamp ---
check('ISO8601 字串解析', normalize.parseTimestamp('2026-07-13T08:00:00Z'), 1783929600);
check('unix秒數字串解析', normalize.parseTimestamp('1000'), 1000);
check('邊界值: 12位數字(9999999999,約2286年)應視為秒非毫秒', normalize.parseTimestamp('9999999999'), 9999999999);
check('邊界值: 13位數字(1000000000000)應視為毫秒', normalize.parseTimestamp('1000000000000'), 1000000000);
check('無法解析的時間字串 -> null', normalize.parseTimestamp('not-a-date'), null);
check('空字串 -> null', normalize.parseTimestamp(''), null);
check('null -> null', normalize.parseTimestamp(null), null);

// --- normalizeAlarmRow ---
check('正常值: 完整中文欄位',
  normalize.normalizeAlarmRow({ '站點代碼': 'TPE-A03', '告警類型': '傳輸中斷', '嚴重度': '緊急', '時間': '2026-07-13T08:00:00Z' }),
  { ok: true, alarm: { site_id: 'TPE-A03', raw_text: '傳輸中斷', severity: 'critical', ts: 1783929600 } }
);
check('正常值: 完整英文欄位',
  normalize.normalizeAlarmRow({ site_id: 'TPE-B07', description: 'Cell Down', severity: 'major', timestamp: '1000' }),
  { ok: true, alarm: { site_id: 'TPE-B07', raw_text: 'Cell Down', severity: 'major', ts: 1000 } }
);
check('無效值: 缺 site_id',
  normalize.normalizeAlarmRow({ description: 'x', timestamp: '1000' }),
  { ok: false, error: '缺少 site_id' }
);
check('無效值: 缺告警描述',
  normalize.normalizeAlarmRow({ site_id: 'TPE-A03', timestamp: '1000' }),
  { ok: false, error: '缺少告警描述文字' }
);
check('無效值: 時間無法解析',
  normalize.normalizeAlarmRow({ site_id: 'TPE-A03', description: 'x', timestamp: 'garbage' }),
  { ok: false, error: '時間格式無法解析: garbage' }
);
check('無效值: 非物件輸入',
  normalize.normalizeAlarmRow(null),
  { ok: false, error: '非物件格式' }
);
check('邊界值: site_id 為純空白字串應視為缺少',
  normalize.normalizeAlarmRow({ site_id: '   ', description: 'x', timestamp: '1000' }),
  { ok: false, error: '缺少 site_id' }
);

// --- normalizeAlarmBatch ---
var batchResult = normalize.normalizeAlarmBatch([
  { site_id: 'TPE-A03', description: '傳輸中斷', severity: 'critical', timestamp: '1000' },
  { description: '缺站點' },
  { site_id: 'TPE-B07', description: '小區離線', severity: 'major', timestamp: '2000' }
]);
check('批次: 3筆輸入, 2成功1失敗', batchResult.normalized.length, 2);
check('批次: errors 含正確 row_index', batchResult.errors[0].row_index, 1);

console.log('');
console.log('通過: ' + passed + ' / 失敗: ' + failed);
if (failed > 0) process.exit(1);
