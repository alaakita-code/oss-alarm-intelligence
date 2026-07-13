/**
 * src/index.js
 *
 * Cloudflare Workers with Static Assets — 統一入口
 * /api/* 交給下面的路由處理；其餘請求（含 Dashboard 本體）交給 env.ASSETS 靜態資產處理。
 * 這是 2026 年 Cloudflare 官方推薦的新專案架構（取代舊的 Pages + Pages Functions 分離模式）。
 */

import { handleHealth } from '../workers/routes/health.js';
import { handleIngestCsv } from '../workers/routes/ingest.js';
import { handleWebhook } from '../workers/routes/webhook.js';
import { handleListIncidents, handleGetIncidentDetail, handleListAlarms } from '../workers/routes/query.js';

function jsonErr(msg, status) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status: status || 400,
    headers: { 'Content-Type': 'application/json' }
  });
}

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var path = url.pathname;

    // /api/* 由本 Worker 處理
    if (path.startsWith('/api/')) {
      try {
        if (path === '/api/health') return await handleHealth(request, env);
        if (path === '/api/alarms/import') return await handleIngestCsv(request, env);
        if (path === '/api/alarms/webhook') return await handleWebhook(request, env);
        if (path === '/api/alarms') return await handleListAlarms(request, env);
        if (path === '/api/incidents') return await handleListIncidents(request, env);

        var incidentMatch = path.match(/^\/api\/incidents\/([a-zA-Z0-9-]+)$/);
        if (incidentMatch) return await handleGetIncidentDetail(request, env, incidentMatch[1]);

        return jsonErr('找不到路由: ' + path, 404);
      } catch (e) {
        return jsonErr('伺服器內部錯誤: ' + (e.message || String(e)), 500);
      }
    }

    // 其餘請求（Dashboard 本體 dist/index.html 等）交給靜態資產處理
    return env.ASSETS.fetch(request);
  }
};
