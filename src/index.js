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
 * CORS：白名單模式。只有在 ALLOWED_ORIGINS 清單內的來源才會拿到
 * Access-Control-Allow-Origin，其餘跨網域來源不給 CORS 標頭（瀏覽器會擋下）。
 * 注意：前端本體(dist/index.html)與 API 同網域，同網域請求本來就不受 CORS 限制，
 * 所以正式前端完全不受此白名單影響；白名單只影響「跨網域」呼叫。
 * 若之後要新增其他允許來源（例如新的測試工具網域），加進 ALLOWED_ORIGINS 即可。
 */

import { handleHealth } from '../workers/routes/health.js';
import { handleIngestCsv } from '../workers/routes/ingest.js';
import { handleWebhook } from '../workers/routes/webhook.js';
import { handleListIncidents, handleGetIncidentDetail, handleListAlarms, handleUpdateIncidentStatus } from '../workers/routes/query.js';

// CORS 白名單：正式前端網域 + 保留的測試彈性。
// 正式前端與 API 同網域，其實不需要列入（同源不觸發 CORS），
// 但列進來可讓「直接用完整網址開啟前端再跨呼叫」等情境也一律放行，較不易誤擋。
var ALLOWED_ORIGINS = [
  'https://oss-alarm-intelligence.alaakita.workers.dev'
];

// CORS 白名單匹配：回傳這個 Origin 是否放行。
// 額外允許 localhost / 127.0.0.1（任意 port）與 file:// 產生的 null origin，
// 方便本機開發與獨立測試工具，同時不對任意公開網域開放。
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return true;
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return true;
  return false;
}

// 依請求來源決定要回哪些 CORS 標頭。
// 命中白名單 → 回該來源 + 允許的方法/標頭；未命中 → 回空物件（不給 CORS 標頭）。
function corsHeadersFor(request) {
  var origin = request.headers.get('Origin');
  if (!isAllowedOrigin(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Ingest-Token',
    'Vary': 'Origin'
  };
}

function jsonErr(msg, status) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status: status || 400,
    headers: { 'Content-Type': 'application/json' }
  });
}

function withCors(response, request) {
  var newHeaders = new Headers(response.headers);
  var corsHeaders = corsHeadersFor(request);
  Object.keys(corsHeaders).forEach(function (key) {
    newHeaders.set(key, corsHeaders[key]);
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
        return new Response(null, { status: 204, headers: corsHeadersFor(request) });
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

        return withCors(response, request);
      } catch (e) {
        return withCors(jsonErr('伺服器內部錯誤: ' + (e.message || String(e)), 500), request);
      }
    }

    // 其餘請求（Dashboard 本體 dist/index.html 等）交給靜態資產處理
    return env.ASSETS.fetch(request);
  }
};
