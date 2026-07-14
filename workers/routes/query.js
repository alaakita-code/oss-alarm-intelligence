// workers/routes/query.js
// 供前端Dashboard讀取告警與事件列表

function jsonRes(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function handleListIncidents(request, env) {
  var url = new URL(request.url);
  var status = url.searchParams.get('status'); // open | acknowledged | resolved
  var limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

  var query = 'SELECT * FROM incidents';
  var binds = [];
  if (status) {
    query += ' WHERE status = ?';
    binds.push(status);
  }
  query += ' ORDER BY created_at DESC LIMIT ?';
  binds.push(limit);

  var stmt = env.DB.prepare(query);
  if (binds.length > 0) stmt = stmt.bind.apply(stmt, binds);
  var result = await stmt.all();

  return jsonRes({ ok: true, incidents: result.results });
}

export async function handleGetIncidentDetail(request, env, incidentId) {
  var incident = await env.DB.prepare('SELECT * FROM incidents WHERE id = ?').bind(incidentId).first();
  if (!incident) {
    return jsonRes({ ok: false, error: '找不到該 Incident' }, 404);
  }

  var alarms = await env.DB.prepare('SELECT * FROM alarms WHERE incident_id = ? ORDER BY ts ASC').bind(incidentId).all();

  return jsonRes({ ok: true, incident: incident, alarms: alarms.results });
}

// 對應新增端點 PATCH /api/incidents/:id
// body 範例: { "status": "acknowledged" }
export async function handleUpdateIncidentStatus(request, env, incidentId) {
  if (request.method !== 'PATCH') {
    return jsonRes({ ok: false, error: 'Method not allowed' }, 405);
  }

  var body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonRes({ ok: false, error: 'Body 必須為合法 JSON' }, 400);
  }

  var allowedStatus = ['open', 'acknowledged', 'resolved'];
  if (allowedStatus.indexOf(body.status) === -1) {
    return jsonRes({ ok: false, error: 'status 必須是 open / acknowledged / resolved 其中之一' }, 400);
  }

  var existing = await env.DB.prepare('SELECT id FROM incidents WHERE id = ?').bind(incidentId).first();
  if (!existing) {
    return jsonRes({ ok: false, error: '找不到該 Incident' }, 404);
  }

  var now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    'UPDATE incidents SET status = ?, updated_at = ? WHERE id = ?'
  ).bind(body.status, now, incidentId).run();

  var updated = await env.DB.prepare('SELECT * FROM incidents WHERE id = ?').bind(incidentId).first();

  return jsonRes({ ok: true, incident: updated });
}

export async function handleListAlarms(request, env) {
  var url = new URL(request.url);
  var siteId = url.searchParams.get('site_id');
  var limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);

  var query = 'SELECT * FROM alarms';
  var binds = [];
  if (siteId) {
    query += ' WHERE site_id = ?';
    binds.push(siteId);
  }
  query += ' ORDER BY ts DESC LIMIT ?';
  binds.push(limit);

  var stmt = env.DB.prepare(query);
  if (binds.length > 0) stmt = stmt.bind.apply(stmt, binds);
  var result = await stmt.all();

  return jsonRes({ ok: true, alarms: result.results });
}
