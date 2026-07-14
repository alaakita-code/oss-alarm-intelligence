// workers/consumer.standalone.js
//
// ⚠️ 這是給 Cloudflare Dashboard「Edit Code」單檔貼上用的合併版本。
// 內容等同 workers/consumer.js + rules/rca_engine.js + workers/lib/normalize.js 三檔合併，
// 因為 Dashboard 網頁版 Edit Code 不支援多檔案 import。
//
// ⚠️ 手改須知：本檔含「自動生成」的 rca_engine 區塊（來自 rca_rules.yaml → build.py）。
// 若要調整規則，正確流程仍是：改 rules/rca_rules.yaml → 重跑 build.py → 重新複製這段貼進來，
// 不要直接手改本檔案中間那段規則區塊，否則會跟 SSOT 脫鉤。
//
// 部署方式：Cloudflare Dashboard → Workers & Pages → Create → Workers →
//   Edit Code → 全選貼上本檔內容 → Deploy
//   之後在該 Worker 的 Settings → Bindings 綁定：DB(D1) / RAW_BUCKET(R2，非必要) /
//   Queue Consumer(oss-alarm-ingest-queue) / AI(Workers AI)

// ============================================================
// 【自動生成區塊開始】對應 rules/rca_engine.js，由 rca_rules.yaml 生成
// ============================================================

var CORRELATION_WINDOW_SECONDS = 900;

var RULES = [
  {
    id: "R-TX-001",
    match_pattern: "傳輸中斷|傳輸異常|Transmission.*(Down|Fail)",
    severity_weight: 100,
    category: "transmission",
    suggestion: "優先檢查傳輸線路與對應傳輸設備連線狀態",
    enabled: true
  },
  {
    id: "R-CELL-001",
    match_pattern: "小區離線|Cell.*(Down|Offline)",
    severity_weight: 60,
    category: "cell",
    suggestion: "確認小區是否因上游傳輸或電力異常而離線，非獨立故障",
    enabled: true
  },
  {
    id: "R-PWR-001",
    match_pattern: "電力異常|市電中斷|Power.*(Fail|Loss)",
    severity_weight: 90,
    category: "power",
    suggestion: "確認站點電力/電池備援狀態，優先排除市電問題",
    enabled: true
  },
  {
    id: "R-HW-001",
    match_pattern: "硬體故障|板卡異常|Hardware.*Fault",
    severity_weight: 80,
    category: "hardware",
    suggestion: "安排現場人員檢查對應板卡，必要時備品更換",
    enabled: true
  },
  {
    id: "R-DEFAULT",
    match_pattern: ".*",
    severity_weight: 10,
    category: "unknown",
    suggestion: "尚無對應規則，建議人工判斷根因",
    enabled: true
  }
];

function _compiledRules() {
  var out = [];
  for (var i = 0; i < RULES.length; i++) {
    if (!RULES[i].enabled) continue;
    out.push({ rule: RULES[i], re: new RegExp(RULES[i].match_pattern) });
  }
  return out;
}
var _COMPILED = _compiledRules();

function matchRule(alarmText) {
  for (var i = 0; i < _COMPILED.length; i++) {
    if (_COMPILED[i].re.test(alarmText)) return _COMPILED[i].rule;
  }
  return null;
}

function isWithinWindow(tsA, tsB, windowSeconds) {
  var w = (typeof windowSeconds === "number") ? windowSeconds : CORRELATION_WINDOW_SECONDS;
  return Math.abs(tsA - tsB) <= w;
}

function correlateAlarms(alarms) {
  var bySite = {};
  for (var i = 0; i < alarms.length; i++) {
    var a = alarms[i];
    if (!bySite[a.site_id]) bySite[a.site_id] = [];
    bySite[a.site_id].push(a);
  }

  var incidents = [];
  for (var siteId in bySite) {
    if (!bySite.hasOwnProperty(siteId)) continue;
    var siteAlarms = bySite[siteId].slice().sort(function(x, y){ return x.ts - y.ts; });
    var used = {};
    for (var j = 0; j < siteAlarms.length; j++) {
      var aa = siteAlarms[j];
      if (used[aa.id]) continue;
      var group = [aa];
      used[aa.id] = true;
      for (var k = j + 1; k < siteAlarms.length; k++) {
        var bb = siteAlarms[k];
        if (used[bb.id]) continue;
        if (isWithinWindow(aa.ts, bb.ts)) {
          group.push(bb);
          used[bb.id] = true;
        }
      }
      var bestRule = null;
      var bestAlarmId = null;
      for (var m = 0; m < group.length; m++) {
        var r = matchRule(group[m].text);
        if (r && (bestRule === null || r.severity_weight > bestRule.severity_weight)) {
          bestRule = r;
          bestAlarmId = group[m].id;
        }
      }
      var alarmIds = [];
      for (var n = 0; n < group.length; n++) alarmIds.push(group[n].id);
      incidents.push({
        site_id: siteId,
        alarm_ids: alarmIds,
        root_cause_alarm_id: bestAlarmId,
        root_cause_rule_id: bestRule ? bestRule.id : null,
        suggestion: bestRule ? bestRule.suggestion : "尚無對應規則，建議人工判斷根因"
      });
    }
  }
  return incidents;
}

// ============================================================
// 【自動生成區塊結束】
// ============================================================

// ---- normalize.js 內嵌（供 webhook 訊息做正規化）----

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
  if (raw === null || raw === undefined || raw === '') return null;
  if (/^\d+$/.test(String(raw).trim())) {
    var n = parseInt(raw, 10);
    return n >= 1e12 ? Math.floor(n / 1000) : n;
  }
  var d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000);
}

function normalizeAlarmRow(rawRow) {
  if (!rawRow || typeof rawRow !== 'object') {
    return { ok: false, error: '非物件格式' };
  }
  var siteId = (rawRow.site_id || rawRow.site || rawRow['站點代碼'] || '').toString().trim();
  if (!siteId) return { ok: false, error: '缺少 site_id' };

  var text = (rawRow.description || rawRow.alarm_type || rawRow['告警類型'] || rawRow['描述'] || '').toString().trim();
  if (!text) return { ok: false, error: '缺少告警描述文字' };

  var ts = parseTimestamp(rawRow.timestamp || rawRow.time || rawRow['時間']);
  if (ts === null) return { ok: false, error: '時間格式無法解析: ' + (rawRow.timestamp || rawRow.time || rawRow['時間']) };

  var severity = normalizeSeverity(rawRow.severity || rawRow['嚴重度']);

  return { ok: true, alarm: { site_id: siteId, raw_text: text, severity: severity, ts: ts } };
}

// ---- Consumer 主邏輯（原 workers/consumer.js）----

function uuid() {
  return crypto.randomUUID();
}

async function generateAiSummary(env, incident, alarmTexts) {
  var fallback = incident.suggestion || '尚無對應規則，建議人工判斷根因';
  if (!env.AI) return fallback;

  var prompt = '以下是電信站點 ' + incident.site_id + ' 的告警序列（依時間順序）：\n' +
    alarmTexts.join('\n') +
    '\n\n請用一段繁體中文（台灣用語）簡短說明可能的根因與建議處理方式，控制在100字以內。';

  var timeoutMs = 8000;
  var aiPromise = env.AI.run('@cf/meta/llama-3-8b-instruct', {
    messages: [{ role: 'user', content: prompt }]
  });
  var timeoutPromise = new Promise(function (resolve) {
    setTimeout(function () { resolve(null); }, timeoutMs);
  });

  try {
    var result = await Promise.race([aiPromise, timeoutPromise]);
    if (!result) return fallback;
    var text = (result.response || '').trim();
    return text || fallback;
  } catch (e) {
    return fallback;
  }
}

async function processBatchCorrelation(env, batchId) {
  var rows = await env.DB.prepare(
    'SELECT * FROM alarms WHERE batch_id = ? AND incident_id IS NULL'
  ).bind(batchId).all();

  var alarms = rows.results.map(function (r) {
    return { id: r.id, site_id: r.site_id, ts: r.ts, text: r.raw_text, severity: r.severity };
  });

  if (alarms.length === 0) return;

  var incidents = correlateAlarms(alarms);
  var now = Math.floor(Date.now() / 1000);

  for (var i = 0; i < incidents.length; i++) {
    var inc = incidents[i];
    var incidentId = uuid();

    var alarmTexts = inc.alarm_ids.map(function (id) {
      var a = alarms.filter(function (x) { return x.id === id; })[0];
      return a ? a.text : '';
    });

    var aiSummary = await generateAiSummary(env, inc, alarmTexts);

    await env.DB.prepare(
      'INSERT INTO incidents (id, site_id, root_cause_alarm_id, root_cause_rule_id, suggestion, ai_summary, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(incidentId, inc.site_id, inc.root_cause_alarm_id, inc.root_cause_rule_id, inc.suggestion, aiSummary, 'open', now, now).run();

    var updateStmts = inc.alarm_ids.map(function (alarmId) {
      return env.DB.prepare('UPDATE alarms SET incident_id = ? WHERE id = ?').bind(incidentId, alarmId);
    });
    await env.DB.batch(updateStmts);
  }
}

async function processWebhookAlarm(env, payload) {
  var normalized = normalizeAlarmRow(payload);
  if (!normalized.ok) return;

  var alarmId = uuid();
  var now = Math.floor(Date.now() / 1000);
  var a = normalized.alarm;

  await env.DB.prepare(
    'INSERT INTO alarms (id, site_id, raw_text, severity, ts, source, r2_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(alarmId, a.site_id, a.raw_text, a.severity, a.ts, 'webhook', null, now).run();

  var recentRows = await env.DB.prepare(
    'SELECT * FROM alarms WHERE site_id = ? AND incident_id IS NULL ORDER BY ts DESC LIMIT 20'
  ).bind(a.site_id).all();

  var alarms = recentRows.results.map(function (r) {
    return { id: r.id, site_id: r.site_id, ts: r.ts, text: r.raw_text };
  });

  var incidents = correlateAlarms(alarms);

  for (var i = 0; i < incidents.length; i++) {
    var inc = incidents[i];
    if (inc.alarm_ids.indexOf(alarmId) === -1) continue;

    var incidentId = uuid();
    var alarmTexts = inc.alarm_ids.map(function (id) {
      var found = alarms.filter(function (x) { return x.id === id; })[0];
      return found ? found.text : '';
    });
    var aiSummary = await generateAiSummary(env, inc, alarmTexts);

    await env.DB.prepare(
      'INSERT INTO incidents (id, site_id, root_cause_alarm_id, root_cause_rule_id, suggestion, ai_summary, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(incidentId, inc.site_id, inc.root_cause_alarm_id, inc.root_cause_rule_id, inc.suggestion, aiSummary, 'open', now, now).run();

    var updateStmts = inc.alarm_ids.map(function (id) {
      return env.DB.prepare('UPDATE alarms SET incident_id = ? WHERE id = ?').bind(incidentId, id);
    });
    await env.DB.batch(updateStmts);
  }
}

export default {
  async queue(batch, env) {
    for (var i = 0; i < batch.messages.length; i++) {
      var msg = batch.messages[i];
      try {
        if (msg.body.type === 'correlate_batch') {
          await processBatchCorrelation(env, msg.body.batch_id);
        } else if (msg.body.type === 'webhook_alarm') {
          await processWebhookAlarm(env, msg.body.payload);
        } else {
          console.error('未知的Queue訊息type: ' + msg.body.type, JSON.stringify(msg.body));
        }
        msg.ack();
      } catch (e) {
        console.error('processQueue失敗: ' + (e.message || String(e)));
        msg.retry();
      }
    }
  },

  // 補上 fetch handler：Cloudflare Dashboard 建立 Worker 時要求至少有 fetch，
  // 這支 Worker 本體用途是 Queue Consumer，fetch 僅回應健康檢查用途。
  async fetch(request, env) {
    return new Response(JSON.stringify({ ok: true, role: 'oss-alarm-consumer', note: '本Worker為Queue Consumer,請透過Queue觸發,非供直接HTTP呼叫' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
