// tests/csv_parse.test.js
var csvParse = require('../workers/lib/csv_parse.js');

var passed = 0, failed = 0;
function check(desc, actual, expected) {
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.log('  ✗ ' + desc); console.log('    got:      ' + a); console.log('    expected: ' + e); }
}

check('基本CSV(有結尾換行)',
  csvParse.parseCsvText('a,b,c\n1,2,3\n'),
  [['a','b','c'], ['1','2','3']]
);

check('邊界值: 無結尾換行的最後一行',
  csvParse.parseCsvText('a,b\n1,2'),
  [['a','b'], ['1','2']]
);

check('邊界值: 只有header沒有資料列',
  csvParse.parseCsvText('a,b,c\n'),
  [['a','b','c']]
);

check('雙引號跳脫: 欄位內含逗號',
  csvParse.parseCsvText('a,b\n"1,000","hello"'),
  [['a','b'], ['1,000','hello']]
);

check('雙引號跳脫: 欄位內含雙引號本身(轉義為"")',
  csvParse.parseCsvText('a\n"he said ""hi"""'),
  [['a'], ['he said "hi"']]
);

check('雙引號跳脫: 欄位內含換行符',
  csvParse.parseCsvText('a,b\n"line1\nline2",normal'),
  [['a','b'], ['line1\nline2','normal']]
);

check('csvTextToObjects: 中文header與資料',
  csvParse.csvTextToObjects('站點代碼,告警類型,嚴重度,時間\nTPE-A03,傳輸中斷,緊急,2026-07-13T08:00:00Z\n'),
  [{ '站點代碼':'TPE-A03', '告警類型':'傳輸中斷', '嚴重度':'緊急', '時間':'2026-07-13T08:00:00Z' }]
);

check('csvTextToObjects: 空白內容應回傳空陣列',
  csvParse.csvTextToObjects(''),
  []
);

check('csvTextToObjects: 中間有空行應跳過',
  csvParse.csvTextToObjects('a,b\n1,2\n\n3,4\n'),
  [{a:'1',b:'2'}, {a:'3',b:'4'}]
);

console.log('');
console.log('通過: ' + passed + ' / 失敗: ' + failed);
if (failed > 0) process.exit(1);
