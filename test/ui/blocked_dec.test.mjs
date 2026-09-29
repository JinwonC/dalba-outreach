// 화면 테스트: 관리자 ⏸ 중복시도 판정 색·필터·승인 확인
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import fs from "fs"; import path from "path";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const ap = await browser.newPage();
ap.on("pageerror", e => { if (/sandboxed/.test(e.message)) return; bad++; console.log("PAGEERROR", e.message); });
await ap.addInitScript(() => { try { localStorage.setItem("nwtoken","t"); localStorage.setItem("outreach_lang","ko"); } catch(_){} });
let approvePosts = 0; let MODE = "ok";
const now = new Date().toISOString();
const row = (to, decision, days, extra) => Object.assign({ to, name: to.split("@")[0], by: "luna@dalbausa.com", byName: "Luna", at: now, decision, daysSinceSent: days,
  origins: [{ by: "jinwon.choi@dalba.com", byName: "Jinwon", at: now, mailbox: decision === "recent" }], replies: decision === "replied" ? [{ by: "jinwon.choi@dalba.com", byName: "Jinwon", inbox: "jinwon.choi@dalba.com", at: now, mailbox: true }] : [] }, extra || {});
await ap.route("**/*", async route => {
  const u = new URL(route.request().url());
  const json = o => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
  const base = { historyEnabled: true, me: { email: "jinwon.choi@dalba.com", name: "Jinwon" }, accounts: [] };
  if (u.pathname === "/api/admin" && route.request().method() === "POST") { approvePosts++; return json({ approved: 1, skipped: 0 }); }
  if (u.pathname === "/api/admin" && u.searchParams.get("view") === "blocked" && MODE === "504")
    return route.fulfill({ status: 504, contentType: "text/plain", body: "An error occurred with your deployment\n\nFUNCTION_INVOCATION_TIMEOUT" });
  if (u.pathname === "/api/admin" && u.searchParams.get("view") === "blocked")
    return json(Object.assign({}, base, { reapproveDays: 15, partial: { mailbox: MODE === "partial", inhouse: false }, rows: [row("r@x.com", "replied", 40, { attempts: 3 }), row("n@x.com", "recent", 3), row("o@x.com", "ok", 40, { handle: "okcreator" }), row("o2@x.com", "ok", 20), row("ih@x.com", "inhouse", 50, { inhouse: true, inhouseHandle: "ihc" })] }));
  if (u.pathname === "/api/admin") return json(Object.assign({}, base, { rows: [], staff: [], totals: {} }));
  if (u.pathname.startsWith("/api/")) return json({ mode: "accounts", me: base.me, admin: true });
  const f = path.join(ROOT, u.pathname);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ status: 200, contentType: f.endsWith(".js") ? "application/javascript" : "text/html", body: fs.readFileSync(f) });
  return route.fulfill({ status: 404, body: "" });
});
await ap.goto("http://app.local/admin.html");
await ap.waitForTimeout(400);
await ap.evaluate(() => go("blocked"));
await ap.waitForFunction(() => /o2@x\.com/.test(document.getElementById("body").innerText));
const cls = await ap.$$eval("#body tbody tr", trs => trs.map(t => t.className));
ck(JSON.stringify(cls) === JSON.stringify(["dec-replied","dec-recent","dec-ok","dec-ok"]), "전체 excludes 🤝 collab rows: " + JSON.stringify(cls));
const bgs = await ap.$$eval("#body tbody tr", trs => trs.map(t => getComputedStyle(t).backgroundColor));
ck(bgs[0] === "rgb(253, 236, 234)" && bgs[1] === "rgb(255, 244, 224)" && bgs[2] === "rgb(232, 240, 254)", "red / orange / blue backgrounds: " + JSON.stringify(bgs));
const t = await ap.innerText("#body");
ck(/🔴 회신 옴/.test(t) && /🟠 최근 15일 내 발송/.test(t) && /🔵 15일 지남/.test(t) && /마지막 발송 3일 전/.test(t), "badges + days");
ck(/전체 4/.test(t) && /🔴 회신 옴 1/.test(t) && /🟠 최근 15일 내 1/.test(t) && /🔵 15일 지남 2/.test(t) && /🤝 협업 중 1/.test(t), "filter counts incl. separate 🤝");
await ap.click("button[onclick=\"setBlkFilter('inhouse')\"]");
await ap.waitForTimeout(150);
const ihRows = await ap.$$eval("#body tbody tr", trs => trs.map(t => t.className));
ck(ihRows.length === 1 && ihRows[0] === "dec-inhouse" && /🤝 협업 중/.test(await ap.innerText("#body tbody")), "🤝 filter shows only collab rows");
await ap.click("button[onclick=\"setBlkFilter('all')\"]");
await ap.waitForTimeout(150);
ck(/메일함/.test(t), "mailbox origin/reply tagged");
await ap.click("button[onclick=\"setBlkFilter('ok')\"]");
await ap.waitForTimeout(150);
const rowsOk = await ap.$$eval("#body tbody tr", trs => trs.map(t => t.className));
ck(rowsOk.length === 2 && rowsOk.every(c => c === "dec-ok"), "filter 🔵 shows only OK rows");
await ap.click("button[onclick=\"setBlkFilter('all')\"]");
await ap.waitForTimeout(150);
ck((await ap.$$("input.blkchk")).length === 4, "전체 button restores all rows");
// approving a red row asks first; dismiss → no POST
let asked = "";
ap.once("dialog", async dlg => { asked = dlg.message(); await dlg.dismiss(); });
await ap.check("input.blkchk[data-to='r@x.com']");
await ap.click("button[onclick='approveSelectedBlocked()']");
await ap.waitForTimeout(200);
ck(/회신 온 크리에이터 1명/.test(asked) && approvePosts === 0, "approving 🔴 asks first; cancel sends nothing: " + asked);
ck(/3회 시도/.test(await ap.innerText("#body")), "collapsed attempts shown");
ck(/@okcreator/.test(await ap.innerText("#body")) && (await ap.getAttribute("input.blkchk[data-to='o@x.com']", "data-handle")) === "okcreator", "creator handle shown in 대상 + carried into approval");
MODE = "partial"; await ap.evaluate(() => load()); await ap.waitForTimeout(400);
ck(/주소록\) 대조를 건너뛰었습니다/.test(await ap.innerText("#body")), "partial notice shown");
MODE = "504"; await ap.evaluate(() => load()); await ap.waitForTimeout(400);
const msg = await ap.innerText("#msg");
ck(/시간 초과/.test(msg) && !/Unexpected token/.test(msg), "504 page → readable message: " + msg);
MODE = "ok"; await ap.evaluate(() => load()); await ap.waitForTimeout(400);
for (const lang of ["en","vi"]) {
  await ap.evaluate(l => I18N.setLang(l), lang);
  await ap.waitForTimeout(200);
  const left = await ap.evaluate(() => { const o=[]; const w=document.createTreeWalker(document.getElementById("body"),NodeFilter.SHOW_TEXT); let n; while((n=w.nextNode())){ const v=n.nodeValue.trim(); if(/[가-힣]/.test(v)) o.push(v);} return [...new Set(o)]; });
  ck(left.length === 0, lang + " untranslated: " + JSON.stringify(left));
}
console.log(`\n${ok} passed, ${bad} failed`);
await browser.close(); process.exit(bad ? 1 : 0);
