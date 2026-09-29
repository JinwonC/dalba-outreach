// 화면 테스트: 관리자 탭 구성 (발송 이력·회신 온 인원 탭 제거)
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import fs from "fs"; import path from "path";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const ap = await browser.newPage({ acceptDownloads: true });
ap.on("pageerror", e => { if (/sandboxed/.test(e.message)) return; bad++; console.log("PAGEERROR", e.message); });
await ap.addInitScript(() => { try { localStorage.setItem("nwtoken","t"); localStorage.setItem("outreach_lang","ko"); } catch(_){} });
const views = [];
await ap.route("**/*", async route => {
  const u = new URL(route.request().url());
  const json = o => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
  const base = { historyEnabled: true, me: { email: "jinwon.choi@dalba.com", name: "Jinwon" }, accounts: [{ email: "luna@dalbausa.com", name: "Luna" }] };
  if (u.pathname === "/api/admin") {
    const v = u.searchParams.get("view"); views.push(v);
    if (v === "approvals") return json(Object.assign({}, base, { rows: [{ by: "luna@dalbausa.com", byName: "Luna", to: "a,b@x.com", handle: "h", name: "N", at: "2026-06-01T00:00:00Z", approvedBy: "jinwon" }] }));
    return json(Object.assign({}, base, { rows: [], staff: [], totals: {}, weeks: [] }));
  }
  if (u.pathname.startsWith("/api/")) return json({ mode: "accounts", me: base.me, admin: true });
  const f = path.join(ROOT, u.pathname);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ status: 200, contentType: f.endsWith(".js") ? "application/javascript" : "text/html", body: fs.readFileSync(f) });
  return route.fulfill({ status: 404, body: "" });
});
await ap.goto("http://app.local/admin.html");
await ap.waitForTimeout(500);
const tabs = await ap.$$eval(".tab", els => els.map(e => e.dataset.v));
ck(!tabs.includes("sent"), "발송 이력 tab removed: " + tabs.join(","));
ck(!tabs.includes("repliers"), "회신 온 인원 tab removed");
ck(["summary","daily","weekly","pipeline","conversations","book","blocked"].every(t => tabs.includes(t)), "other tabs present");
for (const t of tabs) { await ap.evaluate(v => go(v), t); await ap.waitForTimeout(250); }
ck(!views.includes("sent"), "no request for the sent view");
// approvals CSV still works (uses shared csvCell)
await ap.evaluate(() => go("blocked"));
await ap.waitForTimeout(300);
const [dl] = await Promise.all([ap.waitForEvent("download"), ap.evaluate(() => exportApprovalsCsv())]);
const csv = fs.readFileSync(await dl.path(), "utf8");
ck(/"a,b@x\.com"/.test(csv), "approvals CSV escaping still works");
console.log(`\n${ok} passed, ${bad} failed`);
await browser.close(); process.exit(bad ? 1 : 0);
