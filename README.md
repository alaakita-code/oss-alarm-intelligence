# OSS Alarm Intelligence — Cloudflare 純邊緣運算作品線

ALAAKITA 企業級作品集的第二條產品線：不動 v1.2（FastAPI + PostgreSQL），
新開一條純 Cloudflare Serverless/Edge 專案，聚焦 OSS 告警智慧分析單一場景做深。

## 架構

```
CSV匯入 / Webhook
        │
   Workers (Hono-style routes, Pages Functions)
        │  ── 原始payload → R2
        ▼
   Queues (背景解析，避開同步逾時)
        │
   Consumer Worker
        │  ├── 正規化 (純函式 normalize.js，20項單元測試)
        │  ├── Alarm Correlation (rca_engine.js，SSOT生成)
        │  ├── Workers AI → RCA摘要 (8秒逾時 fallback 規則庫)
        │  └── 結構化結果 → D1
        ▼
   Dashboard (ZeroKit單檔HTML) ── D1為主，離線時 localStorage 備援
```

## 已知限制（[ASSUME] 需人工核對）

⚠️ **`rules/rca_rules.yaml` 的欄位結構為 `[ASSUME]`**，是依過去對話片段重建，
非直接讀取 v1.2 原始 `rca_rules.yaml`。請比對 v1.2 的
`backend/rules/rca_rules.yaml` 與 `rules_loader.py` 驗證邏輯後修正本檔，
修正後重新執行 `rules/build.py` 重新生成引擎。

## 目錄結構

```
oss-alarm-intelligence/
├── rules/
│   ├── rca_rules.yaml       ← SSOT 唯一事實來源（[ASSUME]，待核對）
│   ├── build.py             ← 生成器：讀yaml，吐出 rca_engine.py + rca_engine.js
│   ├── rca_engine.py        ← 自動生成，禁止手改
│   ├── rca_engine.js        ← 自動生成，禁止手改
│   └── fixtures/
│       ├── cases.json       ← 15組測試樣本（含時間窗邊界值）
│       └── cross_validate.py ← Python版/JS版交叉驗證
├── workers/
│   ├── lib/
│   │   ├── normalize.js     ← 告警正規化純函式
│   │   └── csv_parse.js     ← 手刻CSV parser純函式
│   ├── routes/
│   │   ├── health.js
│   │   ├── ingest.js        ← AC-1 CSV匯入
│   │   ├── webhook.js       ← AC-2 Webhook
│   │   └── query.js         ← Dashboard查詢用
│   └── consumer.js          ← Queue Consumer，串接rca_engine.js + Workers AI
├── functions/api/
│   └── [[path]].js          ← Pages Functions統一路由入口
├── migrations/
│   └── 0001_init.sql        ← D1 schema (alarms/incidents/import_batches)
├── dist/
│   └── index.html           ← Dashboard（ZeroKit風格，已過alaakita-verify 8/8）
├── tests/
│   ├── normalize.test.js    ← 20項測試全過
│   └── csv_parse.test.js    ← 9項測試全過
└── wrangler.toml
```

## 部署步驟

有兩條路線，依你的環境選擇：

### 路線A：有電腦終端（wrangler CLI，功能較完整）

⚠️ **重要**：Cloudflare Pages 不能直接跑 Queue Consumer，兩者是分開部署的 Worker，
用兩份 wrangler 設定檔（`wrangler.toml` 給 Pages，`wrangler.consumer.toml` 給 Consumer）。

```bash
npm install -g wrangler
wrangler login

# 1. 建立 D1 資料庫，把回傳的 database_id 同時填入
#    wrangler.toml 與 wrangler.consumer.toml 兩份檔案
wrangler d1 create oss-alarm-db
wrangler d1 migrations apply oss-alarm-db --local
wrangler d1 migrations apply oss-alarm-db --remote

# 2. 建立 R2 bucket
wrangler r2 bucket create oss-alarm-raw

# 3. 建立 Queues
wrangler queues create oss-alarm-ingest-queue
wrangler queues create oss-alarm-ingest-dlq

# 4. 設定 webhook 認證 token（Pages 專案用）
wrangler pages secret put INGEST_TOKEN
echo "INGEST_TOKEN=dev-token" > .dev.vars

# 5. 本地開發（Dashboard + API）
wrangler pages dev dist --compatibility-date=2025-01-01

# 6. 部署 Pages（Dashboard + API）
wrangler pages deploy dist

# 7. 部署 Queue Consumer（獨立 Worker，务必額外執行這一步，否則背景關聯分析不會運作）
wrangler deploy --config wrangler.consumer.toml
```

### 路線B：只有手機，無終端環境（全程網頁操作）

1. **GitHub**：新建 repo，把本專案所有檔案（保持資料夾結構）上傳
2. **Cloudflare Pages**：`dash.cloudflare.com` → Workers & Pages → Create → Pages →
   Connect to Git → 選該 repo → Build output directory 填 `dist`
3. **建立資源**（Workers & Pages 側邊欄，純點擊操作）：
   - D1 → Create database（名稱 `oss-alarm-db`）→ 進 Console 分頁貼上
     `migrations/0001_init.sql` 全文並執行
   - R2 → Create bucket（名稱 `oss-alarm-raw`）
   - Queues → Create queue（名稱 `oss-alarm-ingest-queue`，DLQ 可選）
4. **綁定 Pages 專案**：該 Pages 專案 → Settings → Functions → Bindings，
   把 D1/R2/Queue(producer)/Workers AI 逐一用下拉選單綁定
5. **部署 Queue Consumer**（獨立 Worker，不透過 Git，因為要用單檔貼上）：
   - Workers & Pages → Create → **Workers**（不是 Pages）→ Edit Code
   - 貼上 `workers/consumer.standalone.js`**全文**（⚠️ 不是 `consumer.js`，
     standalone 版已內嵌 rca_engine 與 normalize 邏輯，不依賴其他檔案的 import）
   - Deploy 後進 Settings → Bindings，綁定 D1/R2/Queue(consumer端)/Workers AI

⚠️ **路線B的已知限制**：`consumer.standalone.js` 是手動合併版，若之後修改
`rca_rules.yaml` 重新生成規則，必須手動重新複製對應區塊貼回這支單檔（見檔案內註解），
無法像路線A一樣單純跑 `wrangler deploy` 自動同步。

## 驗收條件對照（SDD）

| AC | 內容 | 狀態 |
|---|---|---|
| AC-1 | CSV匯入：imported+skipped=總筆數、原始檔落地R2不覆寫、正規化純函式 | ✅ |
| AC-2 | Webhook：立即回202、原始payload先進Queue | ✅ |
| AC-3 | 時間窗關聯：讀規則庫非寫死、純函式deterministic | ✅（[ASSUME]規則內容待核對） |
| AC-4 | AI摘要：逾時/失敗自動fallback、繁中台灣用語 | ✅ |
| AC-5 | 離線快取：明確標示「離線快取模式」+ 時間戳 | ✅ |

## 未做（依 session 開場核可的禁改區/Non-goals）

- ❌ MCP寫入操作 / Agent自動改資料（guardrail風險最高，未來規劃）
- ❌ 真實SNMP/syslog接入（第一版僅CSV匯入+webhook）
- ❌ 未動 v1.2 任何檔案
