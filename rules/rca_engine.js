// rca_engine.js — 本檔由 build.py 自動生成，禁止手改。
// 如需調整規則，請修改 rca_rules.yaml 後重新執行 build.py。
// ES5 語法，供 Cloudflare Workers / ZeroKit 離線頁共用。

var CORRELATION_WINDOW_SECONDS = 900;

var RULES = [
  {
    id: "R-TX-001",
    match_pattern: "傳輸中斷|傳輸異常|Transmission.*(Down|Fail)",
    severity_weight: 100,
    category: "transmission",
    suggestion: "優先檢查傳輸線路與對應傳輸設備連線狀態",
    enabled: true
  },
  {
    id: "R-CELL-001",
    match_pattern: "小區離線|Cell.*(Down|Offline)",
    severity_weight: 60,
    category: "cell",
    suggestion: "確認小區是否因上游傳輸或電力異常而離線，非獨立故障",
    enabled: true
  },
  {
    id: "R-PWR-001",
    match_pattern: "電力異常|市電中斷|Power.*(Fail|Loss)",
    severity_weight: 90,
    category: "power",
    suggestion: "確認站點電力/電池備援狀態，優先排除市電問題",
    enabled: true
  },
  {
    id: "R-HW-001",
    match_pattern: "硬體故障|板卡異常|Hardware.*Fault",
    severity_weight: 80,
    category: "hardware",
    suggestion: "安排現場人員檢查對應板卡，必要時備品更換",
    enabled: true
  },
  {
    id: "R-DEFAULT",
    match_pattern: ".*",
    severity_weight: 10,
    category: "unknown",
    suggestion: "尚無對應規則，建議人工判斷根因",
    enabled: true
  },
];

function _compiledRules() {
  var out = [];
  for (var i = 0; i < RULES.length; i++) {
    if (!RULES[i].enabled) continue;
    out.push({ rule: RULES[i], re: new RegExp(RULES[i].match_pattern) });
  }
  return out;
}
var _COMPILED = _compiledRules();

function matchRule(alarmText) {
  for (var i = 0; i < _COMPILED.length; i++) {
    if (_COMPILED[i].re.test(alarmText)) return _COMPILED[i].rule;
  }
  return null;
}

function isWithinWindow(tsA, tsB, windowSeconds) {
  var w = (typeof windowSeconds === "number") ? windowSeconds : CORRELATION_WINDOW_SECONDS;
  return Math.abs(tsA - tsB) <= w;
}

function correlateAlarms(alarms) {
  var bySite = {};
  for (var i = 0; i < alarms.length; i++) {
    var a = alarms[i];
    if (!bySite[a.site_id]) bySite[a.site_id] = [];
    bySite[a.site_id].push(a);
  }

  var incidents = [];
  for (var siteId in bySite) {
    if (!bySite.hasOwnProperty(siteId)) continue;
    var siteAlarms = bySite[siteId].slice().sort(function(x, y){ return x.ts - y.ts; });
    var used = {};
    for (var j = 0; j < siteAlarms.length; j++) {
      var aa = siteAlarms[j];
      if (used[aa.id]) continue;
      var group = [aa];
      used[aa.id] = true;
      for (var k = j + 1; k < siteAlarms.length; k++) {
        var bb = siteAlarms[k];
        if (used[bb.id]) continue;
        if (isWithinWindow(aa.ts, bb.ts)) {
          group.push(bb);
          used[bb.id] = true;
        }
      }
      var bestRule = null;
      var bestAlarmId = null;
      for (var m = 0; m < group.length; m++) {
        var r = matchRule(group[m].text);
        if (r && (bestRule === null || r.severity_weight > bestRule.severity_weight)) {
          bestRule = r;
          bestAlarmId = group[m].id;
        }
      }
      var alarmIds = [];
      for (var n = 0; n < group.length; n++) alarmIds.push(group[n].id);
      incidents.push({
        site_id: siteId,
        alarm_ids: alarmIds,
        root_cause_alarm_id: bestAlarmId,
        root_cause_rule_id: bestRule ? bestRule.id : null,
        suggestion: bestRule ? bestRule.suggestion : "尚無對應規則，建議人工判斷根因"
      });
    }
  }
  return incidents;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { RULES: RULES, matchRule: matchRule, isWithinWindow: isWithinWindow,
    correlateAlarms: correlateAlarms, CORRELATION_WINDOW_SECONDS: CORRELATION_WINDOW_SECONDS };
}
