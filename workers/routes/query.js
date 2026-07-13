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
