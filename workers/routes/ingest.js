// workers/routes/ingest.js
// 對應 AC-1: CSV 匯入
//   - 回應含 {imported, skipped, errors[]}, imported+skipped = 總筆數
//   - 原始CSV完整落地R2(選用,key含時間戳,不覆寫)
//   - 每筆寫入D1前先正規化
//   - batch_id 為批次關聯鍵（不依賴r2_ref，r2_ref可能因R2未綁定而為NULL）
//   - 單批筆數上限保護，避免超大檔案撞到記憶體/CPU/D1 batch上限而整包默默失敗
//   - 若整批100%正規化失敗，回明確提示（多半是CSV欄位名稱對不上）
//   - 錯誤分層：alarms寫入D1是核心路徑，失敗才算真失敗；
//     R2備份、import_batches稽核紀錄、Queue送出關聯分析為best-effort，
//     個別失敗不中斷主流程，但會在回應中以warnings告知使用者
//   - 重複告警偵測：以「site_id + raw_text + ts」三者完全相同視為同一筆重複，
//     分兩層檢查——同批次內部自我重複、以及跟資料庫既有紀錄的跨批次重複，
//     兩者皆視為skipped並在errors中標明原因，不會重複寫入或重複觸發關聯分析

import { csvTextToObjects } from '../lib/csv_parse.js';
import { normalizeAlarmRow } from '../lib/normalize.js';

// 單批最大匯入筆數。超過就明確拒絕，而不是讓它撞到D1/Worker限制默默失敗。
var MAX_ROWS_PER_IMPORT = 5000;

// 跨批次重複檢查時，site_id IN (...) 查詢每批最多帶入的參數數量，
// 避免單次SQL參數過多（D1/SQLite有參數數量上限），超過就分批查詢再合併結果。
var DEDUPE_QUERY_CHUNK_SIZE = 100;

function uuid() {
  return crypto.randomUUID();
}

function jsonRes(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function dedupeKey(siteId, rawText, ts) {
  return siteId + '|' + rawText + '|' + ts;
}

function chunkArray(arr, size) {
  var chunks = [];
  for (var i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// best-effort記錄批次稽核資料。失敗不拋出，回傳boolean供呼叫端組裝警告訊息。
async function tryRecordImportBatch(env, batchId, filename, importedCount, skippedCount, errors, r2Key, createdAt) {
  try {
    await env.DB.prepare(
      'INSERT INTO import_batches (id, filename, imported_count, skipped_count, errors_json, r2_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(batchId, filename, importedCount, skippedCount, JSON.stringify(errors), r2Key, createdAt).run();
    return true;
  } catch (e) {
    return false;
  }
}

// 查詢資料庫中既有的告警，比對「site_id + raw_text + ts」是否已存在。
// best-effort：查詢失敗時回傳null（呼叫端會略過跨批次重複檢查並附上警告，不阻擋匯入）。
async function fetchExistingKeys(env, siteIds, minTs, maxTs) {
  if (siteIds.length === 0) return new Set();
  var existingKeys = new Set();
  var chunks = chunkArray(siteIds, DEDUPE_QUERY_CHUNK_SIZE);
  for (var c = 0; c < chunks.length; c++) {
    var chunk = chunks[c];
    var placeholders = chunk.map(function () { return '?'; }).join(',');
    var sql = 'SELECT site_id, raw_text, ts FROM alarms WHERE site_id IN (' + placeholders + ') AND ts >= ? AND ts <= ?';
    var stmt = env.DB.prepare(sql);
    var bindArgs = chunk.concat([minTs, maxTs]);
    var res = await stmt.bind.apply(stmt, bindArgs).all();
    var rows = (res && res.results) || [];
    for (var r = 0; r < rows.length; r++) {
      existingKeys.add(dedupeKey(rows[r].site_id, rows[r].raw_text, rows[r].ts));
    }
  }
  return existingKeys;
}

export async function handleIngestCsv(request, env) {
  if (request.method !== 'POST') {
    return jsonRes({ ok: false, error: 'Method not allowed' }, 405);
  }

  var formData;
  try {
    formData = await request.formData();
  } catch (e) {
    return jsonRes({ ok: false, error: '請以 multipart/form-data 上傳檔案' }, 400);
  }

  var file = formData.get('file');
  if (!file) {
    return jsonRes({ ok: false, error: '缺少 file 欄位' }, 400);
  }

  var text = await file.text();
  var rawRows = csvTextToObjects(text);

  if (rawRows.length === 0) {
    return jsonRes({ ok: false, error: 'CSV 內容為空或格式無法解析' }, 400);
  }

  // 筆數上限檢查：在正規化與寫入D1之前就擋下，避免浪費運算資源
  if (rawRows.length > MAX_ROWS_PER_IMPORT) {
    return jsonRes({
      ok: false,
      error: 'CSV 筆數超過單批上限',
      row_count: rawRows.length,
      max_rows: MAX_ROWS_PER_IMPORT,
      hint: '請將檔案拆分成每批不超過 ' + MAX_ROWS_PER_IMPORT + ' 筆後分次上傳'
    }, 400);
  }

  var batchId = uuid();
  var warnings = [];

  // 原始CSV落地R2(選用，best-effort)。
  var r2Key = null;
  if (env.RAW_BUCKET) {
    var candidateR2Key = 'raw-csv/' + new Date().toISOString().replace(/[:.]/g, '-') + '_' + batchId + '.csv';
    try {
      await env.RAW_BUCKET.put(candidateR2Key, text);
      r2Key = candidateR2Key;
    } catch (e) {
      warnings.push('原始CSV備份至R2失敗，不影響本次匯入結果');
    }
  }

  // ---- 第一階段：逐列正規化 + 同批次內部自我重複檢查 ----
  var errors = [];
  var formatValidCount = 0;
  var candidates = []; // { row_index, alarm, key }
  var seenKeysInBatch = new Set();

  for (var i = 0; i < rawRows.length; i++) {
    var normResult = normalizeAlarmRow(rawRows[i]);
    if (!normResult.ok) {
      errors.push({ row_index: i, error: normResult.error });
      continue;
    }
    formatValidCount++;
    var alarm = normResult.alarm;
    var key = dedupeKey(alarm.site_id, alarm.raw_text, alarm.ts);

    if (seenKeysInBatch.has(key)) {
      errors.push({ row_index: i, error: '重複告警（與同批次內其他列重複），已跳過' });
      continue;
    }
    seenKeysInBatch.add(key);
    candidates.push({ row_index: i, alarm: alarm, key: key });
  }

  var now = Math.floor(Date.now() / 1000);

  // 整批100%正規化失敗（連格式都對不上）：多半是CSV欄位名稱問題，給明確提示
  if (formatValidCount === 0) {
    await tryRecordImportBatch(env, batchId, file.name || 'unknown.csv', 0, errors.length, errors, r2Key, now);

    var headerHint = '本批 ' + rawRows.length + ' 筆全數正規化失敗，請確認 CSV 欄位名稱是否正確（需包含：站點代碼/site_id、告警類型/description、嚴重度/severity、時間/timestamp）';
    return jsonRes({
      ok: false,
      error: headerHint,
      hint: headerHint,
      batch_id: batchId,
      imported: 0,
      skipped: errors.length,
      errors: errors.slice(0, 5)
    }, 400);
  }

  // ---- 第二階段：跨批次重複檢查（跟資料庫既有紀錄比對）----
  var finalCandidates = candidates;
  if (candidates.length > 0) {
    var siteIdSet = {};
    var minTs = candidates[0].alarm.ts;
    var maxTs = candidates[0].alarm.ts;
    for (var j = 0; j < candidates.length; j++) {
      siteIdSet[candidates[j].alarm.site_id] = true;
      if (candidates[j].alarm.ts < minTs) minTs = candidates[j].alarm.ts;
      if (candidates[j].alarm.ts > maxTs) maxTs = candidates[j].alarm.ts;
    }
    var siteIds = Object.keys(siteIdSet);

    var existingKeys = null;
    try {
      existingKeys = await fetchExistingKeys(env, siteIds, minTs, maxTs);
    } catch (e) {
      existingKeys = null;
    }

    if (existingKeys === null) {
      warnings.push('跨批次重複比對查詢失敗，本批已略過重複檢查直接匯入，請留意是否有重複資料');
    } else {
      finalCandidates = [];
      for (var k = 0; k < candidates.length; k++) {
        if (existingKeys.has(candidates[k].key)) {
          errors.push({ row_index: candidates[k].row_index, error: '重複告警（資料庫中已有相同站點/內容/時間的紀錄），已跳過' });
        } else {
          finalCandidates.push(candidates[k]);
        }
      }
    }
  }

  // 全部都是重複資料（格式都對，但比對後100%是重複），跟「格式錯誤」分開給不同提示
  if (finalCandidates.length === 0) {
    await tryRecordImportBatch(env, batchId, file.name || 'unknown.csv', 0, errors.length, errors, r2Key, now);

    var dupHint = '本批 ' + rawRows.length + ' 筆比對後全部為重複告警（同批次內或資料庫已有相同紀錄），未新增任何資料';
    return jsonRes({
      ok: true,
      batch_id: batchId,
      imported: 0,
      skipped: errors.length,
      errors: errors.slice(0, 20),
      warnings: warnings.length > 0 ? warnings : undefined,
      hint: dupHint
    });
  }

  // ---- 第三階段：批次寫入D1（核心路徑）----
  var stmts = [];
  for (var m = 0; m < finalCandidates.length; m++) {
    var a = finalCandidates[m].alarm;
    var alarmId = uuid();
    stmts.push(
      env.DB.prepare(
        'INSERT INTO alarms (id, site_id, raw_text, severity, ts, source, r2_ref, batch_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(alarmId, a.site_id, a.raw_text, a.severity, a.ts, 'csv_import', r2Key, batchId, now)
    );
  }

  if (stmts.length > 0) {
    try {
      await env.DB.batch(stmts);
    } catch (e) {
      return jsonRes({
        ok: false,
        error: '寫入資料庫失敗，本批未匯入，請稍後重試',
        batch_id: batchId
      }, 500);
    }
  }

  // 記錄匯入批次（best-effort）
  var batchRecorded = await tryRecordImportBatch(env, batchId, file.name || 'unknown.csv', finalCandidates.length, errors.length, errors, r2Key, now);
  if (!batchRecorded) {
    warnings.push('匯入批次稽核紀錄寫入失敗，不影響本次告警資料，但此批次不會出現在匯入歷史中');
  }

  // 觸發背景關聯分析（best-effort）
  if (finalCandidates.length > 0) {
    try {
      await env.ALARM_QUEUE.send({ type: 'correlate_batch', batch_id: batchId });
    } catch (e) {
      warnings.push('關聯分析佇列送出失敗，告警已成功匯入，但本批暫不會自動產生 Incident，請稍後於設定頁重試關聯或聯繫維運');
    }
  }

  var response = {
    ok: true,
    batch_id: batchId,
    imported: finalCandidates.length,
    skipped: errors.length,
    errors: errors
  };
  if (warnings.length > 0) {
    response.warnings = warnings;
  }

  return jsonRes(response);
}
