/**
 * src/index.js
 *
 * Cloudflare Workers with Static Assets — 統一入口
 * /api/* 交給下面的路由處理；其餘請求（含 Dashboard 本體）交給 env.ASSETS 靜態資產處理。
 * 這是 2026 年 Cloudflare 官方推薦的新專案架構（取代舊的 Pages + Pages Functions 分離模式）。
 *
 * ⚠️ 這是真正的執行入口，對應 wrangler.toml 的 main = "src/index.js"。
 * functions/api/[[path]].js 是舊版 Pages Functions 慣例路徑，在本專案架構下不會被執行，
 * 若之後要再改路由邏輯，請改這支檔案，不要改 functions/ 底下那份。
 *
 * CORS：加上CORS標頭與OPTIONS預檢處理，讓獨立測試工具/未來其他前端也能呼叫。
 * 若之後要收緊，把 Access-Control-Allow-Origin 從 '*' 改成白名單網域即可。
 */

import { handleHealth } from '../workers/routes/health.js';
import { handleIngestCsv } from '../workers/routes/ingest.js';
import { handleWebhook } from '../workers/routes/webhook.js';
import { handleListIncidents, handleGetIncidentDetail, handleListAlarms, handleUpdateIncidentStatus } from '../workers/routes/query.js';

var CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Ingest-Token'
};

function jsonErr(msg, status) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status: status || 400,
    headers: { 'Content-Type': 'application/json' }
  });
}

function withCors(response) {
  var newHeaders = new Headers(response.headers);
  Object.keys(CORS_HEADERS).forEach(function (key) {
    newHeaders.set(key, CORS_HEADERS[key]);
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var path = url.pathname;

    // /api/* 由本 Worker 處理
    if (path.startsWith('/api/')) {
      // 瀏覽器對PATCH等非簡單方法會先送一次OPTIONS預檢請求，
      // 沒有這段的話，實際的PATCH請求永遠送不到下面的邏輯就被瀏覽器擋掉。
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      try {
        var response;

        if (path === '/api/health') {
          response = await handleHealth(request, env);
        } else if (path === '/api/alarms/import') {
          response = await handleIngestCsv(request, env);
        } else if (path === '/api/alarms/webhook') {
          response = await handleWebhook(request, env);
        } else if (path === '/api/alarms') {
          response = await handleListAlarms(request, env);
        } else if (path === '/api/incidents') {
          response = await handleListIncidents(request, env);
        } else {
          var incidentMatch = path.match(/^\/api\/incidents\/([a-zA-Z0-9-]+)$/);
          if (incidentMatch) {
            if (request.method === 'PATCH') {
              response = await handleUpdateIncidentStatus(request, env, incidentMatch[1]);
            } else {
              response = await handleGetIncidentDetail(request, env, incidentMatch[1]);
            }
          } else {
            response = jsonErr('找不到路由: ' + path, 404);
          }
        }

        return withCors(response);
      } catch (e) {
        return withCors(jsonErr('伺服器內部錯誤: ' + (e.message || String(e)), 500));
      }
    }

    // 其餘請求（Dashboard 本體 dist/index.html 等）交給靜態資產處理
    return env.ASSETS.fetch(request);
  }
};
