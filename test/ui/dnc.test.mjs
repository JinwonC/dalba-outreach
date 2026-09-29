// 화면 테스트: 🚫 수신 거부 등록 — 발송 화면에는 없음(삭제), 관리자 등록 폼, 번역
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import fs from "fs"; import path from "path";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
async function mk(lang, file) {
  const page = await browser.newPage();
  page.on("pageerror", e => { if (/sandboxed/.test(e.message)) return; bad++; console.log("PAGEERROR", e.message); });
  await page.addInitScript(l => { try { localStorage.setItem("nwtoken","t"); localStorage.setItem("outreach_lang", l); } catch(_){} }, lang);
  const posts = [];
  await page.route("**/*", async route => {
    const u = new URL(route.request().url()); const m = route.request().method();
    const json = o => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
    if (u.pathname === "/api/lookup" && m === "POST") {
      const b = JSON.parse(route.request().postData());
      if (b.action === "dnc") { posts.push(b); return json({ ok: true, added: 2, targets: b.items.length }); }
      return json({ historyEnabled: true, count: 1, foundCount: 0, cleanCount: 1, reapproveDays: 15, partial: {}, results: [{ query: "c@x.com", kind: "email", decision: "clean", found: false, sentCount: 0, senders: [], linked: [] }] });
    }
    if (u.pathname === "/api/pipeline" && u.searchParams.get("view") === "unanswered") return json({ rows: [{ email: "stop@x.com", name: "Stop", lastIn: "2026-09-20T00:00:00Z", lastOut: "2026-09-10T00:00:00Z", subject: "Please stop", inCount: 1, waitingDays: 5 }] });
    if (u.pathname === "/api/admin" && m === "POST") { posts.push(JSON.parse(route.request().postData())); return json({ ok: true, targets: 1 }); }
    if (u.pathname === "/api/admin" && u.searchParams.get("view") === "suppress") return json({ historyEnabled: true, me: {}, accounts: [], hiddenMailboxes: [], rows: [] });
    if (u.pathname === "/api/admin") return json({ historyEnabled: true, me: {}, accounts: [], rows: [], staff: [], totals: {}, weeks: [] });
    if (u.pathname === "/api/login") return json({ mode: "accounts" });
    if (u.pathname === "/api/outreach-send" && m === "GET") return json({ me: { email: "luna@dalbausa.com", name: "Luna" }, admin: false, history: { enabled: true } });
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
{
  // 발송 화면에는 수신 거부 등록이 없다 (관리자 화면에서만)
  const { page } = await mk("ko", "index.html");
  await page.evaluate(() => setView("check"));
  await page.fill("#checkQ", "c@x.com"); await page.evaluate(() => runCheck()); await page.waitForSelector("#checkResult table");
  ck(!(await page.$("#dncPanel")) && !(await page.$(".dnclink")), "no DNC form or row links in 중복 검사");
  await page.evaluate(() => setView("unanswered")); await page.waitForSelector("#unansBody table");
  ck(!(await page.$(".undnc")) && !/수신 거부 등록/.test(await page.innerText("body")), "no DNC links in 답장 대기, no button text anywhere");
  await page.close();
}
{
  const { page, posts } = await mk("ko", "admin.html");
  await page.evaluate(() => go("suppress")); await page.waitForSelector("#supAdd");
  await page.fill("#supAdd", "x@y.com, @zz"); await page.fill("#supReason", "admin");
  await page.click("text=🚫 등록");
  await page.waitForTimeout(300);
  ck(posts.length === 1 && posts[0].action === "dnc" && JSON.stringify(posts[0].items) === '["x@y.com","@zz"]', "admin form posts: " + JSON.stringify(posts));
  await page.close();
}
for (const lang of ["en", "vi"]) {
  let page, t, left;
  ({ page } = await mk(lang, "admin.html"));
  await page.evaluate(() => go("suppress")); await page.waitForSelector("#supAdd"); await page.waitForTimeout(300);
  t = await page.innerText("#body");
  left = (t.match(/[^\n]*[가-힣][^\n]*/g) || []);
  ck(!left.length, lang + " admin form untranslated: " + left.join(" | "));
  await page.close();
}
console.log(`\n${ok} passed, ${bad} failed`);
await browser.close(); process.exit(bad ? 1 : 0);
