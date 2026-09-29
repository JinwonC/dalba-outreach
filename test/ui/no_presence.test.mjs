// 화면 테스트: 실시간 접속 표시가 완전히 빠졌는지
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import fs from "fs"; import path from "path";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
for (const pg of ["index.html", "admin.html"]) {
  const page = await browser.newPage();
  page.on("pageerror", e => { if (/sandboxed/.test(e.message)) return; bad++; console.log("PAGEERROR", pg, e.message); });
  await page.addInitScript(() => { try { localStorage.setItem("nwtoken","t"); localStorage.setItem("outreach_lang","ko"); } catch(_){} });
  const hits = [];
  await page.route("**/*", async route => {
    const u = new URL(route.request().url()); const m = route.request().method();
    const json = o => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
    if (/presence/.test(u.pathname)) { hits.push(u.pathname); return route.fulfill({ status: 404, body: "" }); }
    if (u.pathname === "/api/login") return json({ mode: "accounts" });
    if (u.pathname === "/api/outreach-send" && m === "GET") return json({ me: { email: "luna@dalbausa.com", name: "Luna" }, admin: true, history: { enabled: true } });
    if (u.pathname === "/api/admin") return json({ historyEnabled: true, me: { email: "jinwon.choi@dalba.com", name: "Jinwon" }, accounts: [{ email: "luna@dalbausa.com", name: "Luna" }], rows: [], staff: [], totals: {}, weeks: [] });
    if (u.pathname.startsWith("/api/")) return json({ mode: "accounts", me: { email: "luna@dalbausa.com", name: "Luna" }, admin: true });
    const f = path.join(ROOT, u.pathname);
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ status: 200, contentType: f.endsWith(".js") ? "application/javascript" : "text/html", body: fs.readFileSync(f) });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("http://app.local/" + pg);
  await page.waitForTimeout(1200);
  ck(hits.length === 0, pg + ": no presence requests: " + hits.join(","));
  ck(!(await page.$("#presence")) && !(await page.$(".pres-btn")), pg + ": no presence badge");
  ck(!/접속 중/.test(await page.innerText("body")), pg + ": no '접속 중' text");
  await page.close();
}
console.log(`\n${ok} passed, ${bad} failed`);
await browser.close(); process.exit(bad ? 1 : 0);
