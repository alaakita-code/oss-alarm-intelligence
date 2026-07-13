// workers/routes/webhook.js
// 對應 AC-2: Webhook
//   - POST合法payload -> 立即回202(不等背景處理完成)
//   - 原始payload先進Queue，Consumer失敗時訊息保留可重試(Queue原生行為)

import { normalizeAlarmRow } from '../lib/normalize.js';

function jsonRes(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function handleWebhook(request, env) {
  if (request.method !== 'POST') {
    return jsonRes({ ok: false, error: 'Method not allowed' }, 405);
  }

  // 驗證ingest token（簡易共享密鑰，防止未授權來源灌爆Queue）
  var token = request.headers.get('X-Ingest-Token');
  if (env.INGEST_TOKEN && token !== env.INGEST_TOKEN) {
    return jsonRes({ ok: false, error: '未授權' }, 401);
  }

  var payload;
  try {
    payload = await request.json();
  } catch (e) {
    return jsonRes({ ok: false, error: 'Body 必須為合法 JSON' }, 400);
  }

  // 先做基本結構檢查（不做完整正規化，完整正規化留給consumer背景處理）
  var quickCheck = normalizeAlarmRow(payload);
  if (!quickCheck.ok) {
    return jsonRes({ ok: false, error: quickCheck.error }, 400);
  }

  // 立即回202，實際處理丟給Queue consumer背景做
  await env.ALARM_QUEUE.send({ type: 'webhook_alarm', payload: payload, received_at: Math.floor(Date.now() / 1000) });

  return jsonRes({ ok: true, accepted: true }, 202);
}
