/**
 * functions/api/[[path]].js
 *
 * Cloudflare Pages Functions 統一路由
 * 部署後：https://oss-alarm-intelligence.pages.dev/api/* 全部由此處理
 *
 * CORS：本來前端與API同網域不需要CORS，但為了讓獨立測試工具/未來其他前端
 * 也能呼叫這支API，統一在這裡加上CORS標頭。若之後要收緊，把
 * Access-Control-Allow-Origin 從 '*' 改成白名單網域即可。
 */

import { handleHealth } from '../../workers/routes/health.js';
import { handleIngestCsv } from '../../workers/routes/ingest.js';
import { handleWebhook } from '../../workers/routes/webhook.js';
import { handleListIncidents, handleGetIncidentDetail, handleListAlarms, handleUpdateIncidentStatus } from '../../workers/routes/query.js';

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

export async function onRequest(context) {
  var request = context.request;
  var env = context.env;
  var url = new URL(request.url);
  var path = url.pathname;

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
