#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build.py — SSOT 生成器

讀取 rca_rules.yaml，生成：
  - rca_engine.py  (Python 版，供 Consumer Worker 邏輯離線測試 / 未來若接 Python 端使用)
  - rca_engine.js  (ES5 版，供 Cloudflare Workers/Hono 執行，亦可嵌入 ZeroKit 離線頁)

鐵則：rca_engine.py / rca_engine.js 一律標註「本檔由 build.py 自動生成，禁止手改」。
手改需求一律回到 rca_rules.yaml 改完後重新執行本檔。

用法：
  python3 build.py
"""
import re
import sys
import json

try:
    import yaml
except ImportError:
    print("需要 pyyaml，請先: pip install pyyaml --break-system-packages", file=sys.stderr)
    sys.exit(1)


def load_catalog(path):
    with open(path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    return data


def validate_catalog(data):
    """
    對齊 [ASSUME] 版 rules_loader.py 驗證邏輯：
      - 缺欄位 → 該筆規則視為無效，跳過
      - regex 無法編譯 → 該筆規則視為無效，跳過
      - id 重複 → 只保留第一筆，其餘跳過
      - suggestion 為空字串 → 該筆規則視為無效，跳過
    回傳 (valid_rules, errors)
    """
    required_fields = ["id", "match_pattern", "severity_weight", "category", "suggestion", "enabled"]
    seen_ids = set()
    valid_rules = []
    errors = []

    rules = data.get("rules", [])
    for idx, rule in enumerate(rules):
        missing = [f for f in required_fields if f not in rule]
        if missing:
            errors.append("規則 #%d 缺欄位 %s，已跳過" % (idx, missing))
            continue

        if rule["id"] in seen_ids:
            errors.append("規則 id 重複: %s，已跳過後續重複項" % rule["id"])
            continue

        try:
            re.compile(rule["match_pattern"])
        except re.error as e:
            errors.append("規則 %s 的 match_pattern 無法編譯: %s，已跳過" % (rule["id"], e))
            continue

        if not str(rule["suggestion"]).strip():
            errors.append("規則 %s 的 suggestion 為空，已跳過" % rule["id"])
            continue

        seen_ids.add(rule["id"])
        valid_rules.append(rule)

    return valid_rules, errors


def emit_python(data, valid_rules):
    window = data.get("correlation_window_seconds", 900)
    lines = []
    lines.append('# -*- coding: utf-8 -*-')
    lines.append('"""')
    lines.append('rca_engine.py — 本檔由 build.py 自動生成，禁止手改。')
    lines.append('如需調整規則，請修改 rca_rules.yaml 後重新執行 build.py。')
    lines.append('"""')
    lines.append('import re')
    lines.append('')
    lines.append('CORRELATION_WINDOW_SECONDS = %d' % window)
    lines.append('')
    lines.append('RULES = [')
    for r in valid_rules:
        lines.append('    {')
        lines.append('        "id": %r,' % r["id"])
        lines.append('        "match_pattern": %r,' % r["match_pattern"])
        lines.append('        "severity_weight": %r,' % r["severity_weight"])
        lines.append('        "category": %r,' % r["category"])
        lines.append('        "suggestion": %r,' % r["suggestion"])
        lines.append('        "enabled": %r,' % r["enabled"])
        lines.append('    },')
    lines.append(']')
    lines.append('')
    lines.append('_COMPILED = [(r, re.compile(r["match_pattern"])) for r in RULES if r["enabled"]]')
    lines.append('')
    lines.append('')
    lines.append('def match_rule(alarm_text):')
    lines.append('    """給定告警文字，回傳第一個命中的規則 dict；皆未命中回傳 None。"""')
    lines.append('    for rule, compiled in _COMPILED:')
    lines.append('        if compiled.search(alarm_text):')
    lines.append('            return rule')
    lines.append('    return None')
    lines.append('')
    lines.append('')
    lines.append('def is_within_window(ts_a, ts_b, window_seconds=None):')
    lines.append('    """ts_a, ts_b 為 unix 秒數；判斷是否落在關聯時間窗內。"""')
    lines.append('    w = window_seconds if window_seconds is not None else CORRELATION_WINDOW_SECONDS')
    lines.append('    return abs(ts_a - ts_b) <= w')
    lines.append('')
    lines.append('')
    lines.append('def correlate_alarms(alarms):')
    lines.append('    """')
    lines.append('    alarms: list of dict，需含 site_id, ts(unix秒), text')
    lines.append('    回傳: list of incident dict，每個 incident 含 site_id, alarm_ids, root_cause_rule_id, suggestion')
    lines.append('    純函式：同樣輸入必產生同樣輸出，不做任何 I/O。')
    lines.append('    """')
    lines.append('    by_site = {}')
    lines.append('    for a in alarms:')
    lines.append('        by_site.setdefault(a["site_id"], []).append(a)')
    lines.append('')
    lines.append('    incidents = []')
    lines.append('    for site_id, site_alarms in by_site.items():')
    lines.append('        site_alarms = sorted(site_alarms, key=lambda x: x["ts"])')
    lines.append('        used = set()')
    lines.append('        for i, a in enumerate(site_alarms):')
    lines.append('            if a["id"] in used:')
    lines.append('                continue')
    lines.append('            group = [a]')
    lines.append('            used.add(a["id"])')
    lines.append('            for b in site_alarms[i+1:]:')
    lines.append('                if b["id"] in used:')
    lines.append('                    continue')
    lines.append('                if is_within_window(a["ts"], b["ts"]):')
    lines.append('                    group.append(b)')
    lines.append('                    used.add(b["id"])')
    lines.append('            # 決定 root cause：group 內比對每筆的規則，取 severity_weight 最高者')
    lines.append('            best_rule = None')
    lines.append('            best_alarm_id = None')
    lines.append('            for g in group:')
    lines.append('                r = match_rule(g["text"])')
    lines.append('                if r and (best_rule is None or r["severity_weight"] > best_rule["severity_weight"]):')
    lines.append('                    best_rule = r')
    lines.append('                    best_alarm_id = g["id"]')
    lines.append('            incidents.append({')
    lines.append('                "site_id": site_id,')
    lines.append('                "alarm_ids": [g["id"] for g in group],')
    lines.append('                "root_cause_alarm_id": best_alarm_id,')
    lines.append('                "root_cause_rule_id": best_rule["id"] if best_rule else None,')
    lines.append('                "suggestion": best_rule["suggestion"] if best_rule else "尚無對應規則，建議人工判斷根因",')
    lines.append('            })')
    lines.append('    return incidents')
    lines.append('')
    return "\n".join(lines) + "\n"


def emit_js(data, valid_rules):
    window = data.get("correlation_window_seconds", 900)
    lines = []
    lines.append('// rca_engine.js — 本檔由 build.py 自動生成，禁止手改。')
    lines.append('// 如需調整規則，請修改 rca_rules.yaml 後重新執行 build.py。')
    lines.append('// ES5 語法，供 Cloudflare Workers / ZeroKit 離線頁共用。')
    lines.append('')
    lines.append('var CORRELATION_WINDOW_SECONDS = %d;' % window)
    lines.append('')
    lines.append('var RULES = [')
    for r in valid_rules:
        lines.append('  {')
        lines.append('    id: %s,' % json.dumps(r["id"], ensure_ascii=False))
        lines.append('    match_pattern: %s,' % json.dumps(r["match_pattern"], ensure_ascii=False))
        lines.append('    severity_weight: %s,' % json.dumps(r["severity_weight"]))
        lines.append('    category: %s,' % json.dumps(r["category"], ensure_ascii=False))
        lines.append('    suggestion: %s,' % json.dumps(r["suggestion"], ensure_ascii=False))
        lines.append('    enabled: %s' % json.dumps(bool(r["enabled"])))
        lines.append('  },')
    lines.append('];')
    lines.append('')
    lines.append('function _compiledRules() {')
    lines.append('  var out = [];')
    lines.append('  for (var i = 0; i < RULES.length; i++) {')
    lines.append('    if (!RULES[i].enabled) continue;')
    lines.append('    out.push({ rule: RULES[i], re: new RegExp(RULES[i].match_pattern) });')
    lines.append('  }')
    lines.append('  return out;')
    lines.append('}')
    lines.append('var _COMPILED = _compiledRules();')
    lines.append('')
    lines.append('function matchRule(alarmText) {')
    lines.append('  for (var i = 0; i < _COMPILED.length; i++) {')
    lines.append('    if (_COMPILED[i].re.test(alarmText)) return _COMPILED[i].rule;')
    lines.append('  }')
    lines.append('  return null;')
    lines.append('}')
    lines.append('')
    lines.append('function isWithinWindow(tsA, tsB, windowSeconds) {')
    lines.append('  var w = (typeof windowSeconds === "number") ? windowSeconds : CORRELATION_WINDOW_SECONDS;')
    lines.append('  return Math.abs(tsA - tsB) <= w;')
    lines.append('}')
    lines.append('')
    lines.append('function correlateAlarms(alarms) {')
    lines.append('  var bySite = {};')
    lines.append('  for (var i = 0; i < alarms.length; i++) {')
    lines.append('    var a = alarms[i];')
    lines.append('    if (!bySite[a.site_id]) bySite[a.site_id] = [];')
    lines.append('    bySite[a.site_id].push(a);')
    lines.append('  }')
    lines.append('')
    lines.append('  var incidents = [];')
    lines.append('  for (var siteId in bySite) {')
    lines.append('    if (!bySite.hasOwnProperty(siteId)) continue;')
    lines.append('    var siteAlarms = bySite[siteId].slice().sort(function(x, y){ return x.ts - y.ts; });')
    lines.append('    var used = {};')
    lines.append('    for (var j = 0; j < siteAlarms.length; j++) {')
    lines.append('      var aa = siteAlarms[j];')
    lines.append('      if (used[aa.id]) continue;')
    lines.append('      var group = [aa];')
    lines.append('      used[aa.id] = true;')
    lines.append('      for (var k = j + 1; k < siteAlarms.length; k++) {')
    lines.append('        var bb = siteAlarms[k];')
    lines.append('        if (used[bb.id]) continue;')
    lines.append('        if (isWithinWindow(aa.ts, bb.ts)) {')
    lines.append('          group.push(bb);')
    lines.append('          used[bb.id] = true;')
    lines.append('        }')
    lines.append('      }')
    lines.append('      var bestRule = null;')
    lines.append('      var bestAlarmId = null;')
    lines.append('      for (var m = 0; m < group.length; m++) {')
    lines.append('        var r = matchRule(group[m].text);')
    lines.append('        if (r && (bestRule === null || r.severity_weight > bestRule.severity_weight)) {')
    lines.append('          bestRule = r;')
    lines.append('          bestAlarmId = group[m].id;')
    lines.append('        }')
    lines.append('      }')
    lines.append('      var alarmIds = [];')
    lines.append('      for (var n = 0; n < group.length; n++) alarmIds.push(group[n].id);')
    lines.append('      incidents.push({')
    lines.append('        site_id: siteId,')
    lines.append('        alarm_ids: alarmIds,')
    lines.append('        root_cause_alarm_id: bestAlarmId,')
    lines.append('        root_cause_rule_id: bestRule ? bestRule.id : null,')
    lines.append('        suggestion: bestRule ? bestRule.suggestion : "尚無對應規則，建議人工判斷根因"')
    lines.append('      });')
    lines.append('    }')
    lines.append('  }')
    lines.append('  return incidents;')
    lines.append('}')
    lines.append('')
    lines.append('if (typeof module !== "undefined" && module.exports) {')
    lines.append('  module.exports = { RULES: RULES, matchRule: matchRule, isWithinWindow: isWithinWindow,')
    lines.append('    correlateAlarms: correlateAlarms, CORRELATION_WINDOW_SECONDS: CORRELATION_WINDOW_SECONDS };')
    lines.append('}')
    lines.append('')
    return "\n".join(lines)


def main():
    catalog_path = "rca_rules.yaml"
    data = load_catalog(catalog_path)
    valid_rules, errors = validate_catalog(data)

    if errors:
        print("=== 驗證發現以下問題（已跳過對應規則）===")
        for e in errors:
            print("  - " + e)

    if not valid_rules:
        print("錯誤：沒有任何有效規則，中止生成", file=sys.stderr)
        sys.exit(1)

    py_out = emit_python(data, valid_rules)
    js_out = emit_js(data, valid_rules)

    with open("rca_engine.py", "w", encoding="utf-8") as f:
        f.write(py_out)
    with open("rca_engine.js", "w", encoding="utf-8") as f:
        f.write(js_out)

    print("生成完成：rca_engine.py (%d 條有效規則), rca_engine.js" % len(valid_rules))


if __name__ == "__main__":
    main()
