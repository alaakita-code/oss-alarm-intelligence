/**
 * functions/api/[[path]].js
 *
 * Cloudflare Pages Functions 統一路由
 * 部署後：https://oss-alarm-intelligence.pages.dev/api/* 全部由此處理
 * 同一網域，不需CORS。
 */

import { handleHealth } from '../../workers/routes/health.js';
import { handleIngestCsv } from '../../workers/routes/ingest.js';
import { handleWebhook } from '../../workers/routes/webhook.js';
import { handleListIncidents, handleGetIncidentDetail, handleListAlarms, handleUpdateIncidentStatus } from '../../workers/routes/query.js';

function jsonErr(msg, status) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status: status || 400,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequest(context) {
  var request = context.request;
  var env = context.env;
  var url = new URL(request.url);
  var path = url.pathname;

  try {
    if (path === '/api/health') return handleHealth(request, env);
    if (path === '/api/alarms/import') return handleIngestCsv(request, env);
    if (path === '/api/alarms/webhook') return handleWebhook(request, env);
    if (path === '/api/alarms') return handleListAlarms(request, env);
    if (path === '/api/incidents') return handleListIncidents(request, env);

    var incidentMatch = path.match(/^\/api\/incidents\/([a-zA-Z0-9-]+)$/);
    if (incidentMatch) {
      if (request.method === 'PATCH') return handleUpdateIncidentStatus(request, env, incidentMatch[1]);
      return handleGetIncidentDetail(request, env, incidentMatch[1]);
    }

    return jsonErr('找不到路由: ' + path, 404);
  } catch (e) {
    return jsonErr('伺服器內部錯誤: ' + (e.message || String(e)), 500);
  }
}
