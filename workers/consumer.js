// workers/consumer.js
// Queue Consumer：處理 ingest.js / webhook.js 送進來的訊息
// 對應 AC-3(時間窗關聯) 與 AC-4(AI摘要含fallback)

import { correlateAlarms } from '../rules/rca_engine.js';
import { normalizeAlarmRow } from './lib/normalize.js';

function uuid() {
  return crypto.randomUUID();
}

/**
 * 呼叫 Workers AI 產生中文RCA摘要，逾時或失敗自動退回規則庫suggestion。
 * 對應 AC-4：逾時(>8秒)或失敗 -> fallback，不讓使用者看到錯誤畫面。
 */
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
    if (!result) return fallback; // 逾時
    var text = (result.response || '').trim();
    return text || fallback;
  } catch (e) {
    return fallback; // AI呼叫失敗
  }
}

async function processBatchCorrelation(env, batchId) {
  // 讀出該批次所有告警（尚未有incident_id者）
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

    // 回填alarms.incident_id
    var updateStmts = inc.alarm_ids.map(function (alarmId) {
      return env.DB.prepare('UPDATE alarms SET incident_id = ? WHERE id = ?').bind(incidentId, alarmId);
    });
    await env.DB.batch(updateStmts);
  }
}

async function processWebhookAlarm(env, payload) {
  var normalized = normalizeAlarmRow(payload);
  if (!normalized.ok) return; // 已在webhook.js做過快速檢查，理論上不會到這裡失敗

  var alarmId = uuid();
  var now = Math.floor(Date.now() / 1000);
  var a = normalized.alarm;

  await env.DB.prepare(
    'INSERT INTO alarms (id, site_id, raw_text, severity, ts, source, r2_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(alarmId, a.site_id, a.raw_text, a.severity, a.ts, 'webhook', null, now).run();

  // 檢查同站點近期(時間窗內)是否已有未關聯的告警，觸發即時關聯
  var recentRows = await env.DB.prepare(
    'SELECT * FROM alarms WHERE site_id = ? AND incident_id IS NULL ORDER BY ts DESC LIMIT 20'
  ).bind(a.site_id).all();

  var alarms = recentRows.results.map(function (r) {
    return { id: r.id, site_id: r.site_id, ts: r.ts, text: r.raw_text };
  });

  var incidents = correlateAlarms(alarms);

  for (var i = 0; i < incidents.length; i++) {
    var inc = incidents[i];
    if (inc.alarm_ids.indexOf(alarmId) === -1) continue; // 只處理跟這筆新告警相關的incident

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
        // 不ack，讓Queue依max_retries重試，最終進DLQ
        msg.retry();
      }
    }
  }
};
