// workers/routes/health.js
export async function handleHealth(request, env) {
  var checks = {
    d1: false,
    r2: false,
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

  var allOk = checks.d1 && checks.r2 && checks.queue && checks.ai;

  return new Response(JSON.stringify({ ok: allOk, checks: checks }), {
    status: allOk ? 200 : 503,
    headers: { 'Content-Type': 'application/json' }
  });
}
