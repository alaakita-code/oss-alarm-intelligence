
-- migrations/0001_init.sql
-- OSS Alarm Intelligence — D1 初始 schema
-- 原則：原始 payload 存 R2，D1 只放正規化後的結構化資料

CREATE TABLE IF NOT EXISTS alarms (
  id TEXT PRIMARY KEY,               -- uuid
  site_id TEXT NOT NULL,
  raw_text TEXT NOT NULL,            -- 正規化前的原始描述（用於規則比對）
  severity TEXT NOT NULL,            -- critical | major | minor | warning
  ts INTEGER NOT NULL,               -- unix 秒數
  source TEXT NOT NULL,              -- csv_import | webhook
  r2_ref TEXT,                       -- 對應原始 payload 在 R2 的 key（可為 null，例如單筆 webhook 已內嵌）
  incident_id TEXT,                  -- 所屬 incident（正規化後由 correlate_alarms 填入）
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alarms_site_ts ON alarms(site_id, ts);
CREATE INDEX IF NOT EXISTS idx_alarms_incident ON alarms(incident_id);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,               -- uuid
  site_id TEXT NOT NULL,
  root_cause_alarm_id TEXT,
  root_cause_rule_id TEXT,
  suggestion TEXT,
  ai_summary TEXT,                   -- Workers AI 產生的中文摘要（可為 null，失敗時 fallback 用 suggestion）
  status TEXT NOT NULL DEFAULT 'open',  -- open | acknowledged | resolved
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_incidents_site ON incidents(site_id);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  filename TEXT,
  imported_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT,                  -- JSON array of error strings
  r2_ref TEXT NOT NULL,              -- 原始 CSV 在 R2 的 key
  created_at INTEGER NOT NULL
);
