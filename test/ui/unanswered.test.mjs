// 화면 테스트: 📥 답장 대기 — 발송 화면 탭·배지·대화 열기, 관리자 탭 (담당자별 카드·색·번역)
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import fs from "fs"; import path from "path";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const day = d => new Date(Date.now() - d * 86400e3).toISOString();
const ROWS = [
  { email: "a@x.com", name: "Ann", handle: "ann", lastIn: day(9), lastOut: day(12), subject: "Re: Collab", inCount: 2, waitingDays: 9 },
  { email: "b@x.com", name: "", handle: "", lastIn: day(4), lastOut: day(6), subject: "Re: Hi", inCount: 1, waitingDays: 4 },
  { email: "c@x.com", name: "Cee", handle: "", lastIn: day(0), lastOut: "", subject: "Re: Offer", inCount: 1, waitingDays: 0 }
];
async function mk(lang, file) {
  const page = await browser.newPage();
  page.on("pageerror", e => { if (/sandboxed/.test(e.message)) return; bad++; console.log("PAGEERROR", e.message); });
  await page.addInitScript(l => { try { localStorage.setItem("nwtoken","t"); localStorage.setItem("outreach_lang", l); } catch(_){} }, lang);
  const seen = [];
  await page.route("**/*", async route => {
    const u = new URL(route.request().url()); const m = route.request().method();
    const json = o => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
    if (u.pathname === "/api/pipeline" && u.searchParams.get("view") === "unanswered") { seen.push("unans"); return json({ rows: ROWS, syncedAt: day(0.02) }); }
    if (u.pathname === "/api/thread") { seen.push("thread:" + u.searchParams.get("peer")); return json({ peer: u.searchParams.get("peer"), rows: [] }); }
    if (u.pathname === "/api/admin" && u.searchParams.get("view") === "unanswered") {
      seen.push("admin:" + (u.searchParams.get("staff") || "all"));
      return json({ historyEnabled: true, me: { email: "jinwon.choi@dalba.com" }, accounts: [{ email: "luna@dalbausa.com", name: "Luna" }, { email: "seo@dalba.com", name: "Seo" }],
        hiddenMailboxes: [], days: 60, hidden: 1,
        staff: [{ email: "luna@dalbausa.com", name: "Luna", rows: ROWS, syncedAt: day(0.05) }, { email: "seo@dalba.com", name: "Seo", rows: [], syncedAt: day(0.05), syncError: "AUTHENTICATIONFAILED" }] });
    }
    if (u.pathname === "/api/admin") return json({ historyEnabled: true, me: { email: "jinwon.choi@dalba.com" }, accounts: [{ email: "luna@dalbausa.com", name: "Luna" }], rows: [], staff: [], totals: {}, weeks: [] });
    if (u.pathname === "/api/login") return json({ mode: "accounts" });
    if (u.pathname === "/api/outreach-send" && m === "GET") return json({ me: { email: "luna@dalbausa.com", name: "Luna" }, admin: false, history: { enabled: true } });
    if (u.pathname.startsWith("/api/")) return json({});
    const f = path.join(ROOT, u.pathname);
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ status: 200, contentType: f.endsWith(".js") ? "application/javascript" : "text/html", body: fs.readFileSync(f) });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("http://app.local/" + file);
  return { page, seen };
}
{
  const { page, seen } = await mk("ko", "index.html");
  await page.waitForFunction(() => document.getElementById("unansBadge") && document.getElementById("unansBadge").textContent === "3", null, { timeout: 5000 });
  ck(await page.isVisible("#vtabUnans") && await page.isVisible("#unansBadge"), "tab + badge 3 visible");
  await page.click("#vtabUnans");
  await page.waitForSelector("#unansBody table");
  const cls = await page.$$eval("#unansBody tbody tr", t => t.map(r => r.dataset.peer));
  ck(JSON.stringify(cls) === '["a@x.com","b@x.com","c@x.com"]', "longest waiting first: " + cls);
  const bg = await page.$$eval("#unansBody tbody tr", t => t.map(r => getComputedStyle(r).backgroundColor));
  ck(bg[0] === "rgb(253, 236, 234)" && bg[1] === "rgb(255, 244, 224)", "7d+ red, 3d+ orange: " + bg);
  const txt = await page.innerText("#unansBody");
  ck(/9일째 대기/.test(txt) && /오늘 도착/.test(txt) && /받은 메일 2통/.test(txt) && /@ann/.test(txt), "labels: " + txt.slice(0, 200));
  await page.click('#unansBody tr[data-peer="b@x.com"]');
  await page.waitForTimeout(300);
  ck(seen.includes("thread:b@x.com"), "row opens thread");
  await page.close();
}
{
  const { page, seen } = await mk("ko", "admin.html");
  await page.waitForTimeout(500);
  await page.evaluate(() => go("unanswered"));
  await page.waitForSelector("#body table");
  const t = await page.innerText("#body");
  ck(/Luna 3건/.test(t) && /최장 9일/.test(t) && /Seo 0건/.test(t) && /동기화 오류/.test(t), "staff cards: " + t.slice(0, 300));
  ck(/다른 관리자 메일함 1개/.test(t), "hidden admin mailboxes note");
  ck((await page.$$("#body tbody tr")).length === 3, "rows");
  await page.click('#body .tag[onclick*="luna@dalbausa.com"]');
  await page.waitForTimeout(400);
  ck(seen.includes("admin:luna@dalbausa.com"), "clicking a staff card filters by staff: " + seen.join(","));
  await page.close();
}
for (const lang of ["en", "vi"]) {
  for (const file of ["index.html", "admin.html"]) {
    const { page } = await mk(lang, file);
    await page.waitForTimeout(600);
    if (file === "index.html") { await page.click("#vtabUnans"); await page.waitForSelector("#unansBody table"); }
    else { await page.evaluate(() => go("unanswered")); await page.waitForSelector("#body table"); }
    await page.waitForTimeout(300);
    const t = await page.innerText(file === "index.html" ? "#unansView" : "#body");
    const left = (t.match(/[^\n]*[가-힣][^\n]*/g) || []);
    ck(!left.length, lang + " " + file + " untranslated: " + left.join(" | "));
    if (file === "index.html") ck(!/[가-힣]/.test(await page.innerText("#vtabUnans")), lang + " tab label translated");
    await page.close();
  }
}
console.log(`\n${ok} passed, ${bad} failed`);
await browser.close(); process.exit(bad ? 1 : 0);
