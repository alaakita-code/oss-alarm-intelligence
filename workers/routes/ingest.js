// workers/routes/ingest.js
// 對應 AC-1: CSV 匯入
//   - 回應含 {imported, skipped, errors[]}, imported+skipped = 總筆數
//   - 原始CSV完整落地R2(選用,key含時間戳,不覆寫)
//   - 每筆寫入D1前先正規化
//   - batch_id 為批次關聯鍵（不依賴r2_ref，r2_ref可能因R2未綁定而為NULL）
//   - 單批筆數上限保護，避免超大檔案撞到記憶體/CPU/D1 batch上限而整包默默失敗
//   - 若整批100%正規化失敗，回明確提示（多半是CSV欄位名稱對不上）

import { csvTextToObjects } from '../lib/csv_parse.js';
import { normalizeAlarmBatch } from '../lib/normalize.js';

// 單批最大匯入筆數。超過就明確拒絕，而不是讓它撞到D1/Worker限制默默失敗。
var MAX_ROWS_PER_IMPORT = 5000;

function uuid() {
  return crypto.randomUUID();
}

function jsonRes(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
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

  // 原始CSV落地R2(選用)，key含時間戳，不覆寫
  // R2非必要依賴：若未綁定RAW_BUCKET(例如尚未啟用R2訂閱)，則跳過原始檔備份，不影響匯入本身
  // 注意：r2Key 純粹代表「R2原始檔位置」，可以是null，批次關聯一律用 batchId，不依賴這個值
  var r2Key = null;
  if (env.RAW_BUCKET) {
    r2Key = 'raw-csv/' + new Date().toISOString().replace(/[:.]/g, '-') + '_' + batchId + '.csv';
    await env.RAW_BUCKET.put(r2Key, text);
  }

  // 正規化
  var result = normalizeAlarmBatch(rawRows);
  var normalized = result.normalized;
  var errors = result.errors;

  // 整批100%正規化失敗：多半是CSV欄位名稱對不上，給明確提示而非「成功0筆」的模糊回應
  if (normalized.length === 0 && rawRows.length > 0) {
    // 仍記錄這次失敗的匯入嘗試，方便之後追查
    await env.DB.prepare(
      'INSERT INTO import_batches (id, filename, imported_count, skipped_count, errors_json, r2_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(batchId, file.name || 'unknown.csv', 0, errors.length, JSON.stringify(errors), r2Key, Math.floor(Date.now() / 1000)).run();

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

  // 批次寫入D1（逐筆但用單一batch，避免逐筆網路往返）
  var now = Math.floor(Date.now() / 1000);
  var stmts = [];
  for (var i = 0; i < normalized.length; i++) {
    var a = normalized[i];
    var alarmId = uuid();
    stmts.push(
      env.DB.prepare(
        'INSERT INTO alarms (id, site_id, raw_text, severity, ts, source, r2_ref, batch_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(alarmId, a.site_id, a.raw_text, a.severity, a.ts, 'csv_import', r2Key, batchId, now)
    );
  }

  if (stmts.length > 0) {
    await env.DB.batch(stmts);
  }

  // 記錄匯入批次
  await env.DB.prepare(
    'INSERT INTO import_batches (id, filename, imported_count, skipped_count, errors_json, r2_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(batchId, file.name || 'unknown.csv', normalized.length, errors.length, JSON.stringify(errors), r2Key, now).run();

  // 觸發背景關聯分析（丟進Queue，由consumer處理，不同步阻塞回應）
  // 只送 batch_id，consumer端查詢一律用 batch_id，不再依賴 r2_ref
  if (normalized.length > 0) {
    await env.ALARM_QUEUE.send({ type: 'correlate_batch', batch_id: batchId });
  }

  return jsonRes({
    ok: true,
    batch_id: batchId,
    imported: normalized.length,
    skipped: errors.length,
    errors: errors
  });
}
