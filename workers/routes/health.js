// workers/routes/health.js
export async function handleHealth(request, env) {
  var checks = {
    d1: false,
    r2: false,        // 選用：未啟用R2訂閱時此項為false屬正常，不影響整體健康判定
    queue: false,
    ai: false
  };

  try {
    if (env.DB) {
      await env.DB.prepare('SELECT 1').first();
      checks.d1 = true;
    }
  } catch (e) { /* leave false */ }

  checks.r2 = !!env.RAW_BUCKET;
  checks.queue = !!env.ALARM_QUEUE;
  checks.ai = !!env.AI;

  // R2為選用資源，健康判定只看D1/Queue/AI（核心功能依賴項）
  var allOk = checks.d1 && checks.queue && checks.ai;

  return new Response(JSON.stringify({ ok: allOk, checks: checks }), {
    status: allOk ? 200 : 503,
    headers: { 'Content-Type': 'application/json' }
  });
}
