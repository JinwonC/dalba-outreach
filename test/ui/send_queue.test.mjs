// 화면 테스트: 대량 발송 — 서버가 돌려준 leftover 를 이어 보내기, 진전 없으면 멈춤, 시간 초과 안내 문구
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import fs from "fs"; import path from "path";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
async function mk(mode) {
  const page = await browser.newPage();
  page.on("pageerror", e => { if (/sandboxed/.test(e.message)) return; bad++; console.log("PAGEERROR", e.message); });
  await page.addInitScript(() => { try { localStorage.setItem("nwtoken","t"); localStorage.setItem("outreach_lang","ko"); } catch(_){} });
  const calls = [];
  await page.route("**/*", async route => {
    const u = new URL(route.request().url()); const m = route.request().method();
    const json = (o, st) => route.fulfill({ status: st || 200, contentType: "application/json", body: JSON.stringify(o) });
    if (u.pathname === "/api/outreach-send" && m === "POST") {
      const b = JSON.parse(route.request().postData()); calls.push(b.recipients.map(r => r.to));
      if (mode === "stall") return json({ results: [], leftover: b.recipients });
      if (mode === "timeout") return route.fulfill({ status: 504, contentType: "text/plain", body: "An error occurred with your deployment FUNCTION_INVOCATION_TIMEOUT" });
      // 앞의 2명만 보내고 나머지는 leftover
      const done = b.recipients.slice(0, 2), left = b.recipients.slice(2);
      return json({ results: done.map(r => ({ to: r.to, ok: true })), leftover: left });
    }
    if (u.pathname === "/api/login") return json({ mode: "accounts" });
    if (u.pathname === "/api/outreach-send" && m === "GET") return json({ me: { email: "luna@dalbausa.com", name: "Luna" }, admin: false, history: { enabled: true }, maxPerRequest: 25 });
    if (u.pathname === "/api/history" && m === "POST") { const b = JSON.parse(route.request().postData()); return json({ enabled: true, results: b.recipients.map(r => ({ to: r.to, prior: null })) }); }
    if (u.pathname.startsWith("/api/")) return json({});
    const f = path.join(ROOT, u.pathname);
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ status: 200, contentType: f.endsWith(".js") ? "application/javascript" : "text/html", body: fs.readFileSync(f) });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("http://app.local/index.html");
  await page.waitForFunction(() => typeof ME !== "undefined" && ME && ME.email);
  return { page, calls };
}
const list = n => Array.from({ length: n }, (_, i) => ({ to: "q" + i + "@gmail.com", creatorName: "Q" + i }));
{
  const { page, calls } = await mk("partial");
  await page.evaluate(l => doSend(l), list(5));
  await page.waitForTimeout(500);
  ck(calls.length === 3 && JSON.stringify(calls[1]) === '["q2@gmail.com","q3@gmail.com","q4@gmail.com"]' && JSON.stringify(calls[2]) === '["q4@gmail.com"]', "leftover re-sent in order: " + JSON.stringify(calls));
  const t = await page.innerText("#sendResult");
  ck(!/실패|오류/.test(t.split("\n")[0]) || /5/.test(t), "all 5 reported: " + t.slice(0, 120));
  await page.close();
}
{
  const { page, calls } = await mk("stall");
  await page.evaluate(l => doSend(l), list(3));
  await page.waitForTimeout(500);
  ck(calls.length === 2, "stops after two no-progress responses: " + calls.length);
  ck(/시간 안에 처리하지 못했습니다/.test(await page.innerText("#sendResult")), "stall message shown");
  await page.close();
}
{
  const { page } = await mk("timeout");
  await page.evaluate(l => doSend(l), list(2));
  await page.waitForTimeout(500);
  ck(/30분 안에 이미 나간 사람은 자동으로 건너뜁니다/.test(await page.innerText("#sendResult")), "504 message explains safe retry");
  await page.close();
}
console.log(`\n${ok} passed, ${bad} failed`);
await browser.close(); process.exit(bad ? 1 : 0);
