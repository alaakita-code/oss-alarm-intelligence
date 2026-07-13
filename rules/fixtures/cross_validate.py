#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cross_validate.py — 對 rca_engine.py 與 rca_engine.js 餵同樣的 fixtures，
斷言兩邊輸出逐筆相同。任何一筆不同 → exit 1。

用法（於 rules/ 目錄下執行）：
  python3 fixtures/cross_validate.py
"""
import json
import subprocess
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import rca_engine as py_engine  # noqa: E402

FIXTURES_PATH = os.path.join(os.path.dirname(__file__), "cases.json")
JS_ENGINE_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "rca_engine.js")


def load_fixtures():
    with open(FIXTURES_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def run_python_checks(fixtures):
    failures = []

    for case in fixtures["match_rule_cases"]:
        rule = py_engine.match_rule(case["input"])
        got = rule["id"] if rule else None
        if got != case["expected_rule_id"]:
            failures.append("[PY match_rule] %s -> got=%s expected=%s" % (case["desc"], got, case["expected_rule_id"]))

    for case in fixtures["window_cases"]:
        got = py_engine.is_within_window(case["ts_a"], case["ts_b"])
        if got != case["expected_within"]:
            failures.append("[PY is_within_window] %s -> got=%s expected=%s" % (case["desc"], got, case["expected_within"]))

    for case in fixtures["correlate_alarms_cases"]:
        got = py_engine.correlate_alarms(case["alarms"])
        got_sorted = sorted(got, key=lambda x: (x["site_id"], x["alarm_ids"]))
        exp_sorted = sorted(case["expected_incidents"], key=lambda x: (x["site_id"], x["alarm_ids"]))
        if len(got_sorted) != len(exp_sorted):
            failures.append("[PY correlate_alarms] %s -> incident 數量不符 got=%d expected=%d" % (
                case["desc"], len(got_sorted), len(exp_sorted)))
            continue
        for g, e in zip(got_sorted, exp_sorted):
            if (g["site_id"], g["alarm_ids"], g["root_cause_alarm_id"], g["root_cause_rule_id"]) != \
               (e["site_id"], e["alarm_ids"], e["root_cause_alarm_id"], e["root_cause_rule_id"]):
                failures.append("[PY correlate_alarms] %s -> got=%s expected=%s" % (case["desc"], g, e))

    return failures


def run_js_checks(fixtures):
    node_script = """
const engine = require(%r);
const fixtures = %s;
const results = { match_rule: [], window: [], correlate: [] };

for (const c of fixtures.match_rule_cases) {
  const r = engine.matchRule(c.input);
  results.match_rule.push({ desc: c.desc, got: r ? r.id : null, expected: c.expected_rule_id });
}
for (const c of fixtures.window_cases) {
  const got = engine.isWithinWindow(c.ts_a, c.ts_b);
  results.window.push({ desc: c.desc, got: got, expected: c.expected_within });
}
for (const c of fixtures.correlate_alarms_cases) {
  const got = engine.correlateAlarms(c.alarms);
  results.correlate.push({ desc: c.desc, got: got, expected: c.expected_incidents });
}
console.log(JSON.stringify(results));
""" % (JS_ENGINE_PATH, json.dumps(fixtures, ensure_ascii=False))

    tmp_path = "/tmp/_cross_validate_run.js"
    with open(tmp_path, "w", encoding="utf-8") as f:
        f.write(node_script)

    proc = subprocess.run(["node", tmp_path], capture_output=True, text=True)
    if proc.returncode != 0:
        return None, ["[JS] node 執行失敗: " + proc.stderr[:500]]

    try:
        results = json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        return None, ["[JS] 輸出無法解析為 JSON: %s / stdout=%s" % (e, proc.stdout[:300])]

    failures = []
    for r in results["match_rule"]:
        if r["got"] != r["expected"]:
            failures.append("[JS match_rule] %s -> got=%s expected=%s" % (r["desc"], r["got"], r["expected"]))
    for r in results["window"]:
        if r["got"] != r["expected"]:
            failures.append("[JS is_within_window] %s -> got=%s expected=%s" % (r["desc"], r["got"], r["expected"]))
    for r in results["correlate"]:
        got_sorted = sorted(r["got"], key=lambda x: (x["site_id"], x["alarm_ids"]))
        exp_sorted = sorted(r["expected"], key=lambda x: (x["site_id"], x["alarm_ids"]))
        if len(got_sorted) != len(exp_sorted):
            failures.append("[JS correlate_alarms] %s -> incident 數量不符" % r["desc"])
            continue
        for g, e in zip(got_sorted, exp_sorted):
            if (g["site_id"], tuple(g["alarm_ids"]), g["root_cause_alarm_id"], g["root_cause_rule_id"]) != \
               (e["site_id"], tuple(e["alarm_ids"]), e["root_cause_alarm_id"], e["root_cause_rule_id"]):
                failures.append("[JS correlate_alarms] %s -> got=%s expected=%s" % (r["desc"], g, e))

    return results, failures


def main():
    fixtures = load_fixtures()

    py_failures = run_python_checks(fixtures)
    js_results, js_failures = run_js_checks(fixtures)

    all_failures = py_failures + js_failures

    print("=== Python 引擎檢查: %d 個 match_rule / %d 個 window / %d 個 correlate ===" % (
        len(fixtures["match_rule_cases"]), len(fixtures["window_cases"]), len(fixtures["correlate_alarms_cases"])))
    print("=== JS 引擎檢查（相同 fixtures）===")

    if all_failures:
        print("\n交叉驗證失敗，共 %d 項：" % len(all_failures))
        for f in all_failures:
            print("  ✗ " + f)
        sys.exit(1)
    else:
        total = len(fixtures["match_rule_cases"]) + len(fixtures["window_cases"]) + len(fixtures["correlate_alarms_cases"])
        print("\n✓ 全部通過：Python 版與 JS 版對 %d 組 fixtures 輸出逐筆一致" % total)
        sys.exit(0)


if __name__ == "__main__":
    main()
