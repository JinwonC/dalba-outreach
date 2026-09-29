// 화면 테스트: 발송 전 중복 확인 캐시 — 새 수신자만 서버에 묻는지
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import fs from "fs"; import path from "path";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const page = await browser.newPage();
page.on("pageerror", e => { if (/sandboxed/.test(e.message)) return; bad++; console.log("PAGEERROR", e.message); });
await page.addInitScript(() => { try { localStorage.setItem("nwtoken","t"); localStorage.setItem("outreach_lang","ko"); } catch(_){} });
const asked = [];
await page.route("**/*", async route => {
  const u = new URL(route.request().url()); const m = route.request().method();
  const json = o => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
  if (u.pathname === "/api/history" && m === "POST") {
    const b = JSON.parse(route.request().postData()); asked.push(b.recipients.map(r => r.to));
    return json({ enabled: true, results: b.recipients.map(r => ({ to: r.to, prior: r.to === "old@x.com" ? { by: "seoyeon@dalba.com", byName: "Seoyeon", at: "2026-09-01" } : null, inhouse: null })) });
  }
  if (u.pathname === "/api/login") return json({ mode: "accounts" });
  if (u.pathname === "/api/outreach-send" && m === "GET") return json({ me: { email: "luna@dalbausa.com", name: "Luna" }, admin: false, history: { enabled: true } });
  if (u.pathname.startsWith("/api/")) return json({});
  const f = path.join(ROOT, u.pathname);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ status: 200, contentType: f.endsWith(".js") ? "application/javascript" : "text/html", body: fs.readFileSync(f) });
  return route.fulfill({ status: 404, body: "" });
});
await page.goto("http://app.local/index.html");
await page.waitForFunction(() => typeof ME !== "undefined" && ME && ME.email);
await page.evaluate(() => setMode("bulk"));
await page.evaluate(() => { document.getElementById("bulkText").value = "old@x.com\tOld\nnew1@x.com\tN1\nnew2@x.com\tN2"; });
await page.evaluate(() => checkDup()); await page.waitForTimeout(200);
ck(asked.length === 1 && asked[0].length === 3, "first check asks all 3");
ck(await page.evaluate(() => Boolean(heldPriorOf("old@x.com"))), "old@x.com shown as held");
// typing in the pitch → re-check → nothing new to ask
await page.evaluate(() => checkDup()); await page.evaluate(() => checkDup()); await page.waitForTimeout(200);
ck(asked.length === 1, "editing other fields does not re-ask (cached): " + asked.length);
ck(await page.evaluate(() => Boolean(heldPriorOf("old@x.com"))), "held state kept from cache");
// add one recipient → only that one asked
await page.evaluate(() => { document.getElementById("bulkText").value += "\nnew3@x.com\tN3"; });
await page.evaluate(() => checkDup()); await page.waitForTimeout(200);
ck(asked.length === 2 && JSON.stringify(asked[1]) === '["new3@x.com"]', "only the new recipient asked: " + JSON.stringify(asked[1]));
// after a send, sent recipients are re-checked
await page.evaluate(() => { forgetDup(recipients().filter(r => r.to === "new1@x.com")); return checkDup(); }); await page.waitForTimeout(200);
ck(asked.length === 3 && JSON.stringify(asked[2]) === '["new1@x.com"]', "after send, re-asks just the sent ones: " + JSON.stringify(asked[2]));
console.log(`\n${ok} passed, ${bad} failed`);
await browser.close(); process.exit(bad ? 1 : 0);
