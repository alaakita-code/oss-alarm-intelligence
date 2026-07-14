-- migrations/00XX_add_batch_id_to_alarms.sql
-- 目的：alarms 與批次匯入的關聯改用獨立欄位 batch_id，
-- 不再讓 r2_ref（R2原始檔位置，可為NULL）兼職當關聯鍵。
-- 背景：r2_ref = NULL 時，SQL 的 `r2_ref = ?` 比較恆為false（NULL不等於任何值，包含NULL自己），
-- 導致 consumer 端查詢永遠抓不到該批次告警，Incident 永遠不會被建立。

ALTER TABLE alarms ADD COLUMN batch_id TEXT;
CREATE INDEX IF NOT EXISTS idx_alarms_batch_id ON alarms(batch_id);
