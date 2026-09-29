// 화면 테스트: 발송 화면 🔎 중복 검사 판정 색·필터·복사·발송 제목 목록
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import fs from "fs"; import path from "path";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const R = (query, decision, x) => Object.assign({ query, kind: query.includes("@") && !query.startsWith("@") ? "email" : "handle", decision, found: decision !== "clean",
  sentCount: 0, senders: [], lastAt: "", replyCount: 0, replyBy: [], linked: [], inhouse: decision === "inhouse" }, x || {});
const DATA = { historyEnabled: true, count: 6, foundCount: 5, cleanCount: 1, inhouseCount: 1, reapproveDays: 15, partial: { mailbox: false, inhouse: false },
  results: [
    R("fresh@x.com", "clean"),
    R("old@x.com", "ok", { sentCount: 2, senders: ["Luna"], lastAt: "2026-08-01T00:00:00Z", daysSinceSent: 40, lastCampaign: "Aug", sendsTotal: 5,
      sends: [{ by: "luna@dalbausa.com", byName: "Luna", at: "2026-08-01T00:00:00Z", subject: "Hello <b>creator</b>", campaign: "Aug" },
              { by: "jinwon.choi@dalba.com", byName: "Jinwon", at: "2026-07-01T00:00:00Z", hidden: true },
              { by: "seoyeon@dalba.com", byName: "Seoyeon", at: "2026-06-01T00:00:00Z", subject: "Webmail S", mailbox: true }] }),
    R("replied@x.com", "replied", { sendsTotal: 4, sends: [1,2,3,4].map(i => ({ by: "luna@dalbausa.com", byName: "Luna", at: "2026-08-0"+i+"T00:00:00Z", subject: "Subj number " + i })), sentCount: 1, senders: ["Jinwon"], lastAt: "2026-08-01T00:00:00Z", daysSinceSent: 40, replyCount: 2, replyBy: ["Jinwon"], lastReplyAt: "2026-08-10T00:00:00Z" }),
    R("recent@x.com", "recent", { mine: true, sentCount: 1, senders: ["Seoyeon"], lastAt: "2026-09-20T00:00:00Z", daysSinceSent: 5 }),
    R("@collabgirl", "inhouse", { inhouseHandle: "collabgirl", inhouseVia: "handle" }),
    R("nodate@x.com", "unknown", { sentCount: 1, senders: ["Mia"] })
  ] };
const DETAIL_Q = [];
async function mk(lang) {
  const page = await browser.newPage();
  page.on("pageerror", e => { if (/sandboxed/.test(e.message)) return; bad++; console.log("PAGEERROR", e.message); });
  await page.addInitScript(l => { try { localStorage.setItem("nwtoken","t"); localStorage.setItem("outreach_lang", l); } catch(_){} }, lang);
  await page.addInitScript(() => { let c = ""; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async t => { c = t; }, readText: async () => c } }); });
  await page.route("**/*", async route => {
    const u = new URL(route.request().url()); const m = route.request().method();
    const json = o => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
    if (u.pathname === "/api/lookup" && u.searchParams.get("sends")) { DETAIL_Q.push(u.searchParams.get("q")); return json({ historyEnabled: true, total: 5, sends: [
      { by: "luna@dalbausa.com", byName: "Luna", at: "2026-08-01T00:00:00Z", subject: "Hello <b>creator</b>" },
      { by: "luna@dalbausa.com", byName: "Luna", at: "2026-07-15T00:00:00Z", subject: "Follow-up two", mailbox: true },
      { by: "jinwon.choi@dalba.com", byName: "Jinwon", at: "2026-07-01T00:00:00Z", hidden: true, mailbox: true },
      { by: "seoyeon@dalba.com", byName: "Seoyeon", at: "2026-06-01T00:00:00Z", subject: "Webmail S", mailbox: true, summary: true, n: 3 },
      { by: "luna@dalbausa.com", byName: "Luna", at: "2026-05-01T00:00:00Z" }] }); }
    if (u.pathname === "/api/lookup") return json(DATA);
    if (u.pathname === "/api/login") return json({ mode: "accounts" });
    if (u.pathname === "/api/outreach-send" && m === "GET") return json({ me: { email: "luna@dalbausa.com", name: "Luna" }, admin: false, history: { enabled: true } });
    if (u.pathname.startsWith("/api/")) return json({});
    const f = path.join(ROOT, u.pathname);
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ status: 200, contentType: f.endsWith(".js") ? "application/javascript" : "text/html", body: fs.readFileSync(f) });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("http://app.local/index.html");
  await page.waitForFunction(() => typeof ME !== "undefined" && ME && ME.email);
  await page.evaluate(() => setView("check"));
  await page.fill("#checkQ", DATA.results.map(r => r.query).join("\n"));
  await page.evaluate(() => runCheck());
  await page.waitForSelector("#checkResult table");
  return page;
}
{
  const page = await mk("ko");
  const cls = await page.$$eval("#checkResult tbody tr", t => t.map(r => r.className));
  ck(JSON.stringify(cls) === JSON.stringify(["chk-replied","chk-recent","chk-unknown","chk-ok","chk-clean"]), "전체: sorted, inhouse excluded: " + cls);
  const bg = await page.$eval("tr.chk-replied", e => getComputedStyle(e).backgroundColor);
  ck(bg === "rgb(253, 236, 234)", "replied row red: " + bg);
  ck(await page.$eval("tr.chk-recent", e => getComputedStyle(e).backgroundColor) === "rgb(255, 244, 224)", "recent row orange");
  ck(await page.$eval("tr.chk-ok", e => getComputedStyle(e).backgroundColor) === "rgb(232, 240, 254)", "ok row blue");
  const t = await page.innerText("#checkResult");
  ck(/🔴 회신 옴/.test(t) && /🟠 최근 15일 내 발송/.test(t) && /🔵 15일 지남/.test(t) && /✅ 없음/.test(t), "labels shown");
  ck(/마지막 발송 40일 전/.test(t) && /💬 2건/.test(t), "days + reply count");
  ck(/📋 보내도 되는 것 복사 \(3\)/.test(t), "sendable = clean + ok + mine = 3");
  ck(/✉️ 본인 발송 이력 — 계속 보낼 수 있음/.test(await page.innerText("tr.chk-recent")), "mine tag on own creator");
  // 발송 제목 · 발신자
  const okRow = await page.innerText("tr.chk-ok");
  ck(/Luna/.test(okRow) && /Hello <b>creator<\/b>/.test(okRow) && /\[Aug\]/.test(okRow), "subject escaped + campaign: " + okRow);
  ck(/Jinwon/.test(okRow) && /🔒 관리자 메일함 — 제목 비공개/.test(okRow), "admin subject hidden label");
  ck(/Webmail S/.test(okRow) && /메일함/.test(okRow), "mailbox send tag");
  ck(/📨 발송 전체 보기 \(5건\)/.test(okRow), "fallback link only when trimmed (3 of 5)");
  const repRow = await page.innerText("tr.chk-replied");
  ck([1,2,3,4].every(i => repRow.includes("Subj number " + i)) && /발송 4건/.test(repRow) && !/전체 보기/.test(repRow), "all 4 sends inline, no link: " + repRow);
  await page.click("tr.chk-ok .sendsmore");
  await page.waitForFunction(() => /Follow-up two/.test(document.querySelector("tr.chk-ok .sendsall").innerText));
  const det = await page.innerText("tr.chk-ok .sendsall");
  ck(DETAIL_Q[DETAIL_Q.length - 1] === "old@x.com", "detail request for row query");
  ck(/전체 5건/.test(det) && /마지막 1건 · 총 3건/.test(det) && /\(제목 없음\)/.test(det), "detail rendered: " + det);
  await page.click("tr.chk-ok .sendsmore");
  ck(await page.$eval("tr.chk-ok .sendsall", e => e.style.display) === "none", "toggle closes");
  ck((await page.innerText("tr.chk-clean")).includes("—"), "clean row shows dash");
  await page.click("text=🤝 협업 중 1");
  const c2 = await page.$$eval("#checkResult tbody tr", t => t.map(r => r.className));
  ck(JSON.stringify(c2) === '["chk-inhouse"]', "inhouse filter: " + c2);
  await page.click("text=🔴 회신 옴 1");
  ck((await page.$$("#checkResult tbody tr")).length === 1, "replied filter");
  await page.click("text=📋 보내도 되는 것 복사");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  ck(clip.split("\n").sort().join(",") === "fresh@x.com,old@x.com,recent@x.com", "copy sendable: " + clip);
  await page.click("text=✅ 안 보낸 것 복사");
  ck((await page.evaluate(() => navigator.clipboard.readText())) === "fresh@x.com", "copy clean");
  await page.close();
}
for (const lang of ["en", "vi"]) {
  const page = await mk(lang);
  await page.click("tr.chk-ok .sendsmore");
  await page.waitForTimeout(500);
  const t = await page.innerText("#checkView");
  const left = (t.match(/[^\n]*[가-힣][^\n]*/g) || []);
  ck(!left.length, lang + " untranslated: " + left.join(" | "));
  await page.close();
}
console.log(`\n${ok} passed, ${bad} failed`);
await browser.close(); process.exit(bad ? 1 : 0);
