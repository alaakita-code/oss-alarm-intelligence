# -*- coding: utf-8 -*-
"""
rca_engine.py — 本檔由 build.py 自動生成，禁止手改。
如需調整規則，請修改 rca_rules.yaml 後重新執行 build.py。
"""
import re

CORRELATION_WINDOW_SECONDS = 900

RULES = [
    {
        "id": 'R-TX-001',
        "match_pattern": '傳輸中斷|傳輸異常|Transmission.*(Down|Fail)',
        "severity_weight": 100,
        "category": 'transmission',
        "suggestion": '優先檢查傳輸線路與對應傳輸設備連線狀態',
        "enabled": True,
    },
    {
        "id": 'R-CELL-001',
        "match_pattern": '小區離線|Cell.*(Down|Offline)',
        "severity_weight": 60,
        "category": 'cell',
        "suggestion": '確認小區是否因上游傳輸或電力異常而離線，非獨立故障',
        "enabled": True,
    },
    {
        "id": 'R-PWR-001',
        "match_pattern": '電力異常|市電中斷|Power.*(Fail|Loss)',
        "severity_weight": 90,
        "category": 'power',
        "suggestion": '確認站點電力/電池備援狀態，優先排除市電問題',
        "enabled": True,
    },
    {
        "id": 'R-HW-001',
        "match_pattern": '硬體故障|板卡異常|Hardware.*Fault',
        "severity_weight": 80,
        "category": 'hardware',
        "suggestion": '安排現場人員檢查對應板卡，必要時備品更換',
        "enabled": True,
    },
    {
        "id": 'R-DEFAULT',
        "match_pattern": '.*',
        "severity_weight": 10,
        "category": 'unknown',
        "suggestion": '尚無對應規則，建議人工判斷根因',
        "enabled": True,
    },
]

_COMPILED = [(r, re.compile(r["match_pattern"])) for r in RULES if r["enabled"]]


def match_rule(alarm_text):
    """給定告警文字，回傳第一個命中的規則 dict；皆未命中回傳 None。"""
    for rule, compiled in _COMPILED:
        if compiled.search(alarm_text):
            return rule
    return None


def is_within_window(ts_a, ts_b, window_seconds=None):
    """ts_a, ts_b 為 unix 秒數；判斷是否落在關聯時間窗內。"""
    w = window_seconds if window_seconds is not None else CORRELATION_WINDOW_SECONDS
    return abs(ts_a - ts_b) <= w


def correlate_alarms(alarms):
    """
    alarms: list of dict，需含 site_id, ts(unix秒), text
    回傳: list of incident dict，每個 incident 含 site_id, alarm_ids, root_cause_rule_id, suggestion
    純函式：同樣輸入必產生同樣輸出，不做任何 I/O。
    """
    by_site = {}
    for a in alarms:
        by_site.setdefault(a["site_id"], []).append(a)

    incidents = []
    for site_id, site_alarms in by_site.items():
        site_alarms = sorted(site_alarms, key=lambda x: x["ts"])
        used = set()
        for i, a in enumerate(site_alarms):
            if a["id"] in used:
                continue
            group = [a]
            used.add(a["id"])
            for b in site_alarms[i+1:]:
                if b["id"] in used:
                    continue
                if is_within_window(a["ts"], b["ts"]):
                    group.append(b)
                    used.add(b["id"])
            # 決定 root cause：group 內比對每筆的規則，取 severity_weight 最高者
            best_rule = None
            best_alarm_id = None
            for g in group:
                r = match_rule(g["text"])
                if r and (best_rule is None or r["severity_weight"] > best_rule["severity_weight"]):
                    best_rule = r
                    best_alarm_id = g["id"]
            incidents.append({
                "site_id": site_id,
                "alarm_ids": [g["id"] for g in group],
                "root_cause_alarm_id": best_alarm_id,
                "root_cause_rule_id": best_rule["id"] if best_rule else None,
                "suggestion": best_rule["suggestion"] if best_rule else "尚無對應規則，建議人工判斷根因",
            })
    return incidents

