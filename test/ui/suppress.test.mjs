// 화면 테스트: ⛔ 발송 제외 — 발송 화면 표시·확인창, 🔎 중복 검사 표시·복사 제외, 관리자 탭 목록·지우기, 번역
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import fs from "fs"; import path from "path";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const SUPROWS = [
  { field: "e:gone@gmail.com", kind: "email", value: "gone@gmail.com", type: "bounce", reason: "user unknown", source: "imap", by: "luna@dalbausa.com", byName: "Luna", at: "2026-09-20T00:00:00Z" },
  { field: "h:stopme", kind: "handle", value: "stopme", type: "dnc", reason: "asked to stop", source: "manual", addedBy: "luna@dalbausa.com", addedByName: "Luna", at: "2026-09-21T00:00:00Z" }
];
async function mk(lang, file, admin) {
  const page = await browser.newPage();
  page.on("pageerror", e => { if (/sandboxed/.test(e.message)) return; bad++; console.log("PAGEERROR", e.message); });
  await page.addInitScript(l => { try { localStorage.setItem("nwtoken","t"); localStorage.setItem("outreach_lang", l); } catch(_){} }, lang);
  await page.addInitScript(() => { let c = ""; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async t => { c = t; }, readText: async () => c } }); window.confirm = () => true; });
  const posts = [];
  await page.route("**/*", async route => {
    const u = new URL(route.request().url()); const m = route.request().method();
    const json = o => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
    if (u.pathname === "/api/history" && m === "POST") {
      const b = JSON.parse(route.request().postData());
      return json({ enabled: true, results: b.recipients.map(r => ({ to: r.to, prior: null, inhouse: null, suppressed: r.to === "gone@gmail.com" ? { type: "bounce", reason: "user unknown" } : r.to === "stop@x.com" ? { type: "dnc", reason: "asked" } : null })) });
    }
    if (u.pathname === "/api/lookup" && m === "POST") return json({ historyEnabled: true, count: 2, foundCount: 1, cleanCount: 1, reapproveDays: 15, partial: {},
      results: [ { query: "gone@gmail.com", kind: "email", decision: "clean", found: false, sentCount: 0, senders: [], linked: [], suppressed: { type: "bounce", reason: "user unknown" } },
                 { query: "ok@gmail.com", kind: "email", decision: "clean", found: false, sentCount: 0, senders: [], linked: [] } ] });
    if (u.pathname === "/api/admin" && m === "POST") { posts.push(JSON.parse(route.request().postData())); return json({ removed: 1 }); }
    if (u.pathname === "/api/admin" && u.searchParams.get("view") === "suppress") return json({ historyEnabled: true, me: { email: "jinwon.choi@dalba.com" }, accounts: [], hiddenMailboxes: [], rows: SUPROWS });
    if (u.pathname === "/api/admin") return json({ historyEnabled: true, me: { email: "jinwon.choi@dalba.com" }, accounts: [], rows: [], staff: [], totals: {}, weeks: [] });
    if (u.pathname === "/api/login") return json({ mode: "accounts" });
    if (u.pathname === "/api/outreach-send" && m === "GET") return json({ me: { email: "luna@dalbausa.com", name: "Luna" }, admin: Boolean(admin), history: { enabled: true } });
    if (u.pathname.startsWith("/api/")) return json({});
    const f = path.join(ROOT, u.pathname);
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ status: 200, contentType: f.endsWith(".js") ? "application/javascript" : "text/html", body: fs.readFileSync(f) });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("http://app.local/" + file);
  if (file === "index.html") await page.waitForFunction(() => typeof ME !== "undefined" && ME && ME.email);
  else await page.waitForTimeout(500);
  return { page, posts };
}
async function sendScreen(page) {
  await page.evaluate(() => setMode("bulk"));
  await page.evaluate(() => { document.getElementById("bulkText").value = "gone@gmail.com\tGone\nstop@x.com\tStop\nok@gmail.com\tOk"; });
  await page.evaluate(() => checkDup()); await page.waitForTimeout(300);
}
{
  const { page } = await mk("ko", "index.html");
  await sendScreen(page);
  const tbl = await page.innerText("#bulkTable");
  ck(/⛔ 반송 주소/.test(tbl) && /🚫 수신 거부/.test(tbl), "bulk table tags: " + tbl.replace(/\n/g, " | "));
  const info = await page.innerText("#dupInfo");
  ck(/발송 제외 2명은 보내지 않습니다/.test(info), "dupInfo box: " + info);
  await page.close();
}
{
  const { page } = await mk("ko", "index.html");
  await page.evaluate(() => setView("check"));
  await page.fill("#checkQ", "gone@gmail.com\nok@gmail.com");
  await page.evaluate(() => runCheck());
  await page.waitForSelector("#checkResult table");
  const t = await page.innerText("#checkResult");
  ck(/⛔ 반송 주소/.test(t) && /⛔ 발송 제외 1/.test(t), "check shows tag + filter: " + t.slice(0, 200));
  ck(/📋 보내도 되는 것 복사 \(1\)/.test(t), "suppressed excluded from sendable");
  await page.click("text=📋 보내도 되는 것 복사");
  ck((await page.evaluate(() => navigator.clipboard.readText())) === "ok@gmail.com", "copied only ok@gmail.com");
  await page.close();
}
{
  const { page, posts } = await mk("ko", "admin.html", true);
  await page.evaluate(() => go("suppress"));
  await page.waitForSelector("#body table");
  const t = await page.innerText("#body");
  ck(/전체 2/.test(t) && /반송 주소 1/.test(t) && /수신 거부 1/.test(t) && /@stopme/.test(t) && /반송 알림\(메일함\)/.test(t) && /직접 등록/.test(t), "admin list: " + t.slice(0, 300));
  await page.click("text=🚫 수신 거부 1");
  ck((await page.$$("#body tbody tr")).length === 1, "type filter");
  await page.evaluate(() => setSupFilter("all"));
  await page.check('.supchk[data-field="e:gone@gmail.com"]');
  await page.click("text=🗑 선택 지우기");
  await page.waitForTimeout(300);
  ck(posts.length === 1 && posts[0].action === "unsuppress" && JSON.stringify(posts[0].fields) === '["e:gone@gmail.com"]', "remove posts field: " + JSON.stringify(posts));
  await page.close();
}
for (const lang of ["en", "vi"]) {
  let { page } = await mk(lang, "index.html");
  await sendScreen(page);
  let t = await page.innerText("#dupInfo") + "\n" + await page.innerText("#bulkTable");
  let left = (t.match(/[^\n]*[가-힣][^\n]*/g) || []);
  ck(!left.length, lang + " send screen untranslated: " + left.join(" | "));
  await page.close();
  ({ page } = await mk(lang, "admin.html", true));
  await page.evaluate(() => go("suppress")); await page.waitForSelector("#body table"); await page.waitForTimeout(300);
  t = await page.innerText("#body") + "\n" + await page.innerText(".tabs");
  left = (t.match(/[^\n]*[가-힣][^\n]*/g) || []);
  ck(!left.length, lang + " admin untranslated: " + left.join(" | "));
  await page.close();
}
console.log(`\n${ok} passed, ${bad} failed`);
await browser.close(); process.exit(bad ? 1 : 0);
