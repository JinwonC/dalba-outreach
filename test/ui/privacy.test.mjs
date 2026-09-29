// 화면 테스트: 관리자 메일함 대화는 어느 탭에서도 열리지 않음
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import fs from "fs"; import path from "path";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const ap = await browser.newPage();
ap.on("pageerror", e => { if (/sandboxed/.test(e.message)) return; bad++; console.log("PAGEERROR", e.message); });
await ap.addInitScript(() => { try { localStorage.setItem("nwtoken","t"); localStorage.setItem("outreach_lang","ko"); } catch(_){} });
let threadHits = 0;
const now = "2026-06-01T00:00:00Z";
await ap.route("**/*", async route => {
  const u = new URL(route.request().url());
  const json = o => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
  const base = { historyEnabled: true, me: { email: "jinwon.choi@dalba.com", name: "Jinwon" }, hiddenMailboxes: ["hannie@dalbausa.com"],
    accounts: [{ email: "jinwon.choi@dalba.com", name: "Jinwon" }, { email: "hannie@dalbausa.com", name: "Hannie" }, { email: "luna@dalbausa.com", name: "Luna" }] };
  if (u.pathname === "/api/thread") { threadHits++; return json({ rows: [] }); }
  if (u.pathname === "/api/admin") {
    const v = u.searchParams.get("view");
    if (v === "blocked") return json(Object.assign({}, base, { rows: [{ to: "k@x.com", name: "K", by: "luna@dalbausa.com", byName: "Luna", at: now,
      origins: [{ by: "hannie@dalbausa.com", byName: "Hannie", at: now }, { by: "luna@dalbausa.com", byName: "Luna", at: now }],
      replies: [{ by: "hannie@dalbausa.com", byName: "Hannie", inbox: "hannie@dalbausa.com", at: now, subject: "Re H" }, { by: "luna@dalbausa.com", byName: "Luna", inbox: "luna@dalbausa.com", at: now, subject: "Re L" }] }] }));
    if (v === "repliers") return json(Object.assign({}, base, { rows: [
      { email: "a@x.com", name: "A", count: 1, lastAt: now, inbox: "hannie@dalbausa.com", staff: ["Hannie"], lastSubject: "re" },
      { email: "c@x.com", name: "C", count: 1, lastAt: now, inbox: "luna@dalbausa.com", staff: ["Luna"], lastSubject: "re" }] }));
    if (v === "pipeline") return json(Object.assign({}, base, { pipelineOf: "hannie@dalbausa.com", rows: [{ email: "z@x.com", name: "Z", stage: "outreach", sends: 1, replies: 0 }] }));
    return json(Object.assign({}, base, { staff: [], totals: {} }));
  }
  if (u.pathname.startsWith("/api/")) return json({ mode: "accounts", me: base.me, admin: true });
  const f = path.join(ROOT, u.pathname);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ status: 200, contentType: f.endsWith(".js") ? "application/javascript" : "text/html", body: fs.readFileSync(f) });
  return route.fulfill({ status: 404, body: "" });
});
await ap.goto("http://app.local/admin.html");
await ap.waitForTimeout(500);
// 중복시도
await ap.evaluate(() => go("blocked"));
// 이 줄은 Luna 본인 발송 이력이 있는 옛 기록(기본 숨김) — 보이게 켜고 확인한다
await ap.waitForFunction(() => BLK_DATA);
await ap.evaluate(() => { if(!BLK_SHOW_SELF) toggleBlkSelf(); });
await ap.waitForFunction(() => /Re L/.test(document.getElementById("body").innerText));
const lines = await ap.$$eval("#body .threadline", els => els.map(e => e.getAttribute("data-thread-staff")));
ck(lines.length === 2 && lines.every(x => x === "luna@dalbausa.com"), "blocked: only Luna's lines are openable: " + JSON.stringify(lines));
ck(await ap.$("#body [data-thread-staff='hannie@dalbausa.com']") === null, "blocked: no link into Hannie's mailbox");
const txt = await ap.innerText("#body");
ck(/Hannie/.test(txt) && /Re H/.test(txt), "blocked: Hannie send/reply still listed (who/when) without content link");
// direct call guard
await ap.evaluate(() => openThread("hannie@dalbausa.com", "a@x.com"));
await ap.waitForTimeout(200);
ck(threadHits === 0, "no request for Hannie's conversation (" + threadHits + ")");
ck(await ap.evaluate(() => getComputedStyle(document.getElementById("threadModal")).display === "none"), "modal stays closed");
// pipeline of another admin: cards not clickable
await ap.evaluate(() => go("pipeline"));
await ap.waitForFunction(() => /관리자 메일함이라/.test(document.getElementById("body").innerText));
await ap.click(".kcard");
await ap.waitForTimeout(200);
ck(threadHits === 0, "pipeline card of admin mailbox opens nothing");
for (const lang of ["en","vi"]) {
  await ap.evaluate(l => I18N.setLang(l), lang);
  await ap.waitForTimeout(200);
  const left = await ap.evaluate(() => { const o=[]; const w=document.createTreeWalker(document.getElementById("body"),NodeFilter.SHOW_TEXT); let n; while((n=w.nextNode())){ const v=n.nodeValue.trim(); if(/[가-힣]/.test(v)) o.push(v);} return o; });
  ck(left.length === 0, lang + " pipeline untranslated: " + JSON.stringify(left));
}
console.log(`\n${ok} passed, ${bad} failed`);
await browser.close(); process.exit(bad ? 1 : 0);
