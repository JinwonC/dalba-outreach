// 화면 테스트: 발송 화면 — 이메일↔핸들 연결·협업 표시
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };

async function setup(page, { admin = false } = {}) {
  await page.addInitScript(() => { try { localStorage.setItem("nwtoken", "t"); localStorage.setItem("outreach_lang", "ko"); } catch (_) {} });
  await page.route("**/*", async route => {
    const u = new URL(route.request().url());
    const m = route.request().method();
    const json = o => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
    if (u.pathname === "/api/login") return json({ mode: "accounts" });
    if (u.pathname === "/api/outreach-send" && m === "GET") return json({ me: { email: admin ? "jinwon.choi@dalba.com" : "luna@dalbausa.com", name: admin ? "Jinwon" : "Luna" }, admin, history: { enabled: true, windowDays: 90 } });
    if (u.pathname === "/api/history" && m === "POST") {
      const b = JSON.parse(route.request().postData() || "{}");
      return json({ enabled: true, results: (b.recipients || []).map(r => ({ to: r.to, prior: null,
        inhouse: /yaniratips/.test(r.to) ? { handle: "yaniratips", via: "email-prefix" } : null })) });
    }
    if (u.pathname === "/api/inhouse" && m === "GET") return json({ configured: true, count: 2, handles: ["yaniratips", "_serahmichelle"], emailCount: 1, updatedAt: new Date().toISOString() });
    if (u.pathname === "/api/inhouse" && m === "POST") {
      const b = JSON.parse(route.request().postData() || "{}");
      return json({ results: (b.queries || []).map(q => ({ q, isEmail: q.includes("@") && !q.startsWith("@"),
        match: /yaniratips/.test(q) ? { handle: "yaniratips", via: q.includes("gmail") ? "email-prefix" : "handle" } : (q === "jeanyanira@gmail.com" ? { handle: "yaniratips", via: "sheet-email" } : null),
        linkedHandles: q === "z@y.com" ? ["linkme"] : [] })) });
    }
    if (u.pathname.startsWith("/api/")) return json({});
    const f = path.join(ROOT, u.pathname === "/" ? "index.html" : u.pathname);
    if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      const ct = f.endsWith(".html") ? "text/html" : f.endsWith(".js") ? "application/javascript" : f.endsWith(".png") ? "image/png" : "text/plain";
      return route.fulfill({ status: 200, contentType: ct, body: fs.readFileSync(f) });
    }
    return route.fulfill({ status: 404, body: "" });
  });
}

// collect Korean text nodes left untranslated inside given roots
const LEFT = (page, sels) => page.evaluate(sels => {
  const out = [];
  sels.forEach(sel => { const root = document.querySelector(sel); if (!root) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n; while ((n = w.nextNode())) { const t = n.nodeValue.trim(); if (/[가-힣]/.test(t)) out.push(t); } });
  return out;
}, sels);

const page = await browser.newPage();
page.on("pageerror", e => { if (/sandboxed/.test(e.message)) return; bad++; console.log("PAGEERROR", e.message); });
await setup(page);
await page.goto("http://app.local/index.html");
await page.waitForFunction(() => typeof ME !== "undefined" && ME && ME.email);

// ── pre-check: email-only yaniratipsparati → 협업 표시 ──
await page.fill("#to", "yaniratipsparati@gmail.com");
await page.fill("#creatorName", "Yanira");
await page.fill("#handle", "");
await page.evaluate(() => checkDup());
await page.waitForFunction(() => /yaniratips/.test(document.getElementById("dupInfo").innerText), null, { timeout: 5000 });
const dup = await page.innerText("#dupInfo");
ck(/🤝 협업 중/.test(dup) && /@yaniratips/.test(dup) && /이메일 주소로 추정/.test(dup), "pre-check shows 협업 중 @yaniratips (이메일 주소로 추정)");
ck(/보류됩니다/.test(dup), "non-admin told it will be held");

// ── confirm dialog: in-house held + B (no-handle) warning ──
await page.evaluate(() => startSend());
await page.waitForSelector("#confirmModal", { state: "visible" });
const cb = await page.innerText("#confirmBody");
ck(/협업 중인 크리에이터 1명은 보류됩니다/.test(cb), "confirm: in-house held line (by email)");
ck(/핸들이 비어 있는 1명/.test(cb), "confirm: B no-handle warning");
await page.evaluate(() => closeConfirm());

// with handle filled → no B warning
await page.fill("#handle", "https://www.tiktok.com/@yaniratips");
await page.evaluate(() => startSend());
const cb2 = await page.innerText("#confirmBody");
ck(!/핸들이 비어 있는/.test(cb2), "confirm: no warning when handle filled");
ck(/협업 중인 크리에이터 1명은 보류됩니다/.test(cb2), "confirm: URL handle recognized as in-house");
await page.evaluate(() => closeConfirm());

// ── collab list search (server match) ──
await page.evaluate(() => { setView("inhouse"); });
await page.waitForFunction(() => INHOUSE_DATA !== null);
await page.fill("#inhouseSearch", "yaniratipsparati@gmail.com\njeanyanira@gmail.com\nz@y.com\nhello@gmail.com");
await page.evaluate(() => paintInhouse());
await page.waitForFunction(() => /hello@gmail\.com/.test(document.getElementById("inhouseResult").innerText));
const ir = await page.innerText("#inhouseResult");
ck(/🤝 협업 중 2/.test(ir.replace(/\s+/g, " ")) || /협업 중\s*2/.test(ir), "collab search counts 2 hits: " + ir.slice(0, 120).replace(/\n/g, " | "));
ck(/시트 이메일/.test(ir) && /이메일 주소로 추정/.test(ir), "collab search shows reasons");
ck(/🔗 @linkme/.test(ir), "collab search shows linked handle");

// ── translations: en & vi leave no Korean in the new UI ──
for (const lang of ["en", "vi"]) {
  await page.evaluate(l => I18N.setLang(l), lang);
  await page.evaluate(() => paintInhouse());
  await page.waitForFunction(() => /hello@gmail\.com/.test(document.getElementById("inhouseResult").innerText));
  await page.waitForTimeout(150);
  const leftIh = await LEFT(page, ["#inhouseResult"]);
  ck(leftIh.length === 0, lang + " collab search untranslated: " + JSON.stringify(leftIh));
  await page.evaluate(() => { setView("send"); });
  await page.fill("#handle", "");
  await page.evaluate(() => { paintDup(); startSend(); });
  await page.waitForTimeout(150);
  const left = await LEFT(page, ["#dupInfo", "#confirmBody"]);
  // names/emails are not Korean; any Korean here = missing translation
  ck(left.length === 0, lang + " send screen untranslated: " + JSON.stringify(left));
  await page.evaluate(() => closeConfirm());
  await page.evaluate(() => { setView("inhouse"); });
}

// ── admin view: 중복시도 badge with reason, translated ──
const ap = await browser.newPage();
ap.on("pageerror", e => { if (/sandboxed/.test(e.message)) return; bad++; console.log("ADMIN PAGEERROR", e.message); });
await ap.addInitScript(() => { try { localStorage.setItem("nwtoken", "t"); localStorage.setItem("outreach_lang", "ko"); } catch (_) {} });
await ap.route("**/*", async route => {
  const u = new URL(route.request().url());
  const json = o => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
  if (u.pathname === "/api/admin") {
    if (u.searchParams.get("view") === "blocked") return json({ historyEnabled: true, me: { email: "jinwon.choi@dalba.com", name: "Jinwon" }, accounts: [],
      rows: [{ to: "yaniratipsparati@gmail.com", handle: "", name: "Yanira", at: new Date().toISOString(), by: "luna@dalbausa.com", byName: "Luna",
        origins: [{ by: "seoyeon@dalba.com", byName: "Seoyeon", at: new Date().toISOString() }], replies: [], inhouse: true, inhouseHandle: "yaniratips", inhouseVia: "email-prefix" }] });
    return json({ historyEnabled: true, me: { email: "jinwon.choi@dalba.com", name: "Jinwon" }, accounts: [], staff: [], totals: {} });
  }
  if (u.pathname.startsWith("/api/")) return json({ mode: "accounts", me: { email: "jinwon.choi@dalba.com", name: "Jinwon" }, admin: true });
  const f = path.join(ROOT, u.pathname);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ status: 200, contentType: f.endsWith(".js") ? "application/javascript" : "text/html", body: fs.readFileSync(f) });
  return route.fulfill({ status: 404, body: "" });
});
await ap.goto("http://app.local/admin.html");
await ap.waitForTimeout(500);
await ap.evaluate(() => go("blocked"));
await ap.waitForFunction(() => /yaniratips/.test(document.getElementById("body").innerText), null, { timeout: 5000 });
const ab = await ap.innerText("#body");
ck(/🤝 협업 중/.test(ab) && /@yaniratips · 이메일 주소로 추정/.test(ab), "admin 중복시도 badge with handle+reason");
for (const lang of ["en", "vi"]) {
  await ap.evaluate(l => I18N.setLang(l), lang);
  await ap.waitForTimeout(150);
  const tds = await ap.evaluate(() => [...document.querySelectorAll("#body td .tag, #body td .muted span")].map(e => e.innerText).filter(t => /[가-힣]/.test(t)));
  ck(tds.length === 0, lang + " admin badge untranslated: " + JSON.stringify(tds));
}

console.log(`\n${ok} passed, ${bad} failed`);
await browser.close();
process.exit(bad ? 1 : 0);
