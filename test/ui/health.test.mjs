// 화면 테스트: 🩺 시스템 상태 — 관리자 경고줄(문제·정상·더 보기), 담당자 본인 동기화 실패 알림, 번역
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import fs from "fs"; import path from "path";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const BAD = { ok: false, cronAt: "2026-09-29T10:00:00Z", items: [
  { level: "error", code: "cron-stale", msg: "자동 실행(크론)이 2시간 동안 돌지 않았습니다 — 예약 발송·리마인드·동기화가 멈춰 있습니다" },
  { level: "error", code: "sync-error", name: "Jinwon (admin)", msg: "메일함 동기화 실패", hint: "앱 비밀번호가 바뀌었거나 만료됐을 수 있습니다 — 네이버웍스에서 외부 앱 비밀번호를 새로 받아 Vercel 의 NW_ACCOUNTS 에 넣어 주세요", detail: "AUTHENTICATIONFAILED" },
  { level: "warn", code: "mailbox-stale", name: "Luna", msg: "메일함 동기화가 8시간 전이 마지막입니다" },
  { level: "warn", code: "round-stale", msg: "메일함 동기화가 5시간 동안 한 바퀴를 끝내지 못했습니다 — 회신·주소록 숫자가 늦을 수 있습니다" },
  { level: "warn", code: "msgs-full", name: "Luna", msg: "메일 본문 저장 공간이 가득 차 새 메일은 본문 없이 저장됩니다 (MSG_STORE_MAX_MB)" },
  { level: "info", code: "never-synced", name: "Seo", msg: "아직 메일함 동기화 기록이 없습니다" } ] };
const GOOD = { ok: true, cronAt: "2026-09-29T10:00:00Z", items: [{ level: "info", code: "catching-up", name: "Seo", msg: "보낸편지함을 처음부터 읽는 중입니다 (회신 판정은 다 읽은 뒤에)" }] };
async function mk(lang, file, health, unans) {
  const page = await browser.newPage();
  page.on("pageerror", e => { if (/sandboxed/.test(e.message)) return; bad++; console.log("PAGEERROR", e.message); });
  await page.addInitScript(l => { try { localStorage.setItem("nwtoken","t"); localStorage.setItem("outreach_lang", l); } catch(_){} }, lang);
  await page.route("**/*", async route => {
    const u = new URL(route.request().url()); const m = route.request().method();
    const json = (o, st) => route.fulfill({ status: st || 200, contentType: "application/json", body: JSON.stringify(o) });
    if (u.pathname === "/api/admin" && u.searchParams.get("view") === "health") return health === "fail" ? json({ error: "이력 저장소 오류: ERR max requests limit exceeded — Upstash 요청 한도 초과: Vercel → Storage → 해당 DB 에서 요금제(Pay as You Go)·예산을 확인하세요" }, 502) : json(health);
    if (u.pathname === "/api/admin") return json({ historyEnabled: true, me: { email: "jinwon.choi@dalba.com" }, accounts: [], rows: [], staff: [], totals: {}, weeks: [] });
    if (u.pathname === "/api/pipeline" && u.searchParams.get("view") === "unanswered") return json(unans || { rows: [] });
    if (u.pathname === "/api/login") return json({ mode: "accounts" });
    if (u.pathname === "/api/outreach-send" && m === "GET") return json({ me: { email: "luna@dalbausa.com", name: "Luna" }, admin: false, history: { enabled: true } });
    if (u.pathname.startsWith("/api/")) return json({});
    const f = path.join(ROOT, u.pathname);
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ status: 200, contentType: f.endsWith(".js") ? "application/javascript" : "text/html", body: fs.readFileSync(f) });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("http://app.local/" + file);
  await page.waitForTimeout(800);
  return page;
}
{
  const page = await mk("ko", "admin.html", BAD);
  let t = await page.innerText("#health");
  ck(/확인이 필요합니다 \(5\)/.test(t) && /크론/.test(t) && /Jinwon \(admin\) — 메일함 동기화 실패/.test(t) && /앱 비밀번호/.test(t), "problems shown: " + t.slice(0, 300));
  ck(!/본문 없이/.test(t) && /더 보기/.test(t), "first 4 only, 더 보기");
  await page.click("#health >> text=더 보기");
  t = await page.innerText("#health");
  ck(/본문 없이/.test(t) && !/아직 메일함 동기화 기록이 없습니다/.test(t), "expanded; info items not in problem list");
  ck(await page.$eval("#health > div", e => e.className) === "err", "red when there is an error");
  await page.close();
}
{
  const page = await mk("ko", "admin.html", GOOD);
  const t = await page.innerText("#health");
  ck(/✅ 시스템 정상/.test(t) && /마지막 자동 실행/.test(t) && /참고 1건/.test(t), "healthy line: " + t);
  await page.close();
}
{
  const page = await mk("ko", "admin.html", "fail");
  const t = await page.innerText("#health");
  ck(/시스템 점검 실패/.test(t) && /Upstash 요청 한도 초과/.test(t), "storage failure explained: " + t.slice(0, 200));
  await page.close();
}
{
  const page = await mk("ko", "index.html", null, { rows: [], syncError: "AUTHENTICATIONFAILED", syncHint: "앱 비밀번호가 바뀌었거나 만료됐을 수 있습니다 — 네이버웍스에서 외부 앱 비밀번호를 새로 받아 Vercel 의 NW_ACCOUNTS 에 넣어 주세요" });
  const t = await page.innerText("#myHealth");
  ck(/내 메일함 동기화가 실패하고 있습니다/.test(t) && /앱 비밀번호/.test(t) && /관리자에게 알려 주세요/.test(t), "staff notice: " + t);
  await page.close();
  const p2 = await mk("ko", "index.html", null, { rows: [] });
  ck((await p2.innerText("#myHealth")).trim() === "", "no notice when fine");
  await p2.close();
}
for (const lang of ["en", "vi"]) {
  let page = await mk(lang, "admin.html", BAD);
  await page.click("#health a >> nth=0"); await page.waitForTimeout(300);
  let t = await page.innerText("#health");
  let left = (t.match(/[^\n]*[가-힣][^\n]*/g) || []);
  ck(!left.length, lang + " admin banner untranslated: " + left.join(" | "));
  await page.close();
  page = await mk(lang, "admin.html", GOOD);
  t = await page.innerText("#health");
  ck(!/[가-힣]/.test(t), lang + " healthy line: " + t);
  await page.close();
  page = await mk(lang, "index.html", null, { rows: [], syncError: "X", syncHint: "앱 비밀번호가 바뀌었거나 만료됐을 수 있습니다 — 네이버웍스에서 외부 앱 비밀번호를 새로 받아 Vercel 의 NW_ACCOUNTS 에 넣어 주세요" });
  t = await page.innerText("#myHealth");
  left = (t.match(/[^\n]*[가-힣][^\n]*/g) || []);
  ck(!left.length, lang + " staff notice untranslated: " + left.join(" | "));
  await page.close();
}
console.log(`\n${ok} passed, ${bad} failed`);
await browser.close(); process.exit(bad ? 1 : 0);
