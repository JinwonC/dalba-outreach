// 테스트 실행기 — test/*.test.js (서버) 와 test/ui/*.test.mjs (화면, --ui) 를 하나씩 따로 돌린다.
// 각 테스트는 자기 안에서 가짜 저장소·가짜 메일 서버를 만들므로 서로 섞이지 않게 별도 프로세스로.
//   npm test            서버 테스트
//   npm run test:ui     화면 테스트 (playwright + chromium 필요, CHROMIUM_PATH 로 경로 지정 가능)
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ui = process.argv.includes("--ui");
const dir = ui ? path.join(__dirname, "ui") : __dirname;
const only = process.argv.slice(2).filter(a => !a.startsWith("--"));
const files = fs.readdirSync(dir)
  .filter(f => ui ? f.endsWith(".test.mjs") : f.endsWith(".test.js"))
  .filter(f => !only.length || only.some(o => f.includes(o)))
  .sort();

let failed = 0;
for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, f)], { encoding: "utf8", timeout: 180e3 });
  const out = (r.stdout || "") + (r.stderr || "");
  const ok = r.status === 0;
  const summary = (out.trim().split("\n").filter(l => /passed|failed/.test(l)).pop() || "").trim();
  console.log((ok ? "✓ " : "✗ ") + f.padEnd(34) + summary.padEnd(22) + ((Date.now() - t0) / 1000).toFixed(1) + "s");
  if (!ok) { failed++; console.log(out.split("\n").filter(l => /FAIL|THREW|Error|PAGEERROR/.test(l)).slice(0, 20).map(l => "    " + l).join("\n") || out.slice(-2000)); }
}
console.log(`\n${files.length - failed}/${files.length} test files passed`);
process.exit(failed ? 1 : 0);
