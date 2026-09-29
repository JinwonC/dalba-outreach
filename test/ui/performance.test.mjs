// 화면 테스트: 📈 성과 — 요약 카드·담당자별·캠페인별 표(비율 막대), 협업 시트 못 읽음 안내, 번역
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import fs from "fs"; import path from "path";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const DATA = { historyEnabled: true, me: {}, accounts: [], inhouseChecked: true,
  totals: { contacted: 200, replied: 30, collab: 6 },
  staff: [{ staff: "luna@dalbausa.com", name: "Luna", contacted: 120, replied: 24, collab: 5 }, { staff: "seo@dalba.com", name: "Seo", contacted: 80, replied: 6, collab: 1 }],
  campaigns: [{ campaign: "Sept Promo", contacted: 150, replied: 25, collab: 5 }, { campaign: "(네이버웍스에서 직접 보낸 메일)", contacted: 50, replied: 5, collab: 1 }],
  subjects: [{ subject: "Paid Collab X {{name}}", contacted: 40, replied: 10 }, { subject: "Hi {{name}} — collab?", contacted: 20, replied: 2 }, { subject: "Tiny test", contacted: 2, replied: 2 }], subjectsSkipped: 12 };
async function mk(lang, data) {
  const page = await browser.newPage();
  page.on("pageerror", e => { if (/sandboxed/.test(e.message)) return; bad++; console.log("PAGEERROR", e.message); });
  await page.addInitScript(l => { try { localStorage.setItem("nwtoken","t"); localStorage.setItem("outreach_lang", l); } catch(_){} }, lang);
  const views = [];
  await page.route("**/*", async route => {
    const u = new URL(route.request().url());
    const json = o => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
    if (u.pathname === "/api/admin" && u.searchParams.get("view") === "performance") { views.push(u.search); return json(data); }
    if (u.pathname === "/api/admin" && u.searchParams.get("view") === "health") return json({ ok: true, items: [] });
    if (u.pathname === "/api/admin") return json({ historyEnabled: true, me: {}, accounts: [], rows: [], staff: [], totals: {}, weeks: [] });
    if (u.pathname.startsWith("/api/")) return json({});
    const f = path.join(ROOT, u.pathname);
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ status: 200, contentType: f.endsWith(".js") ? "application/javascript" : "text/html", body: fs.readFileSync(f) });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("http://app.local/admin.html");
  await page.waitForTimeout(400);
  await page.evaluate(() => go("performance"));
  await page.waitForSelector("#body table");
  return { page, views };
}
{
  const { page, views } = await mk("ko", DATA);
  const t = await page.innerText("#body");
  ck(/보낸 크리에이터\s*200/.test(t) && /회신율 15%/.test(t) && /협업 전환율 3%/.test(t), "summary cards: " + t.slice(0, 200));
  ck(/Luna/.test(t) && /20%/.test(t) && /Sept Promo/.test(t), "staff and campaign tables");
  const w = await page.$$eval("#body table tbody tr:first-child td:nth-child(4) div > span:last-child > span", e => e.map(x => x.style.width));
  ck(w[0] === "20%", "rate bar width: " + w);
  ck(views[0].includes("view=performance"), "requested performance view");
  let st = await page.innerText("#body");
  ck(/제목별 회신율/.test(st) && /Paid Collab X \{\{name\}\}/.test(st) && /25%/.test(st) && !/Tiny test/.test(st), "subject table, small samples hidden");
  ck(/툴 발송 12건은 빠졌습니다/.test(st) && /표본 적은 제목도 보기 \(1\)/.test(st), "skipped note + toggle");
  await page.evaluate(() => toggleSubjAll());
  st = await page.innerText("#body");
  ck(/Tiny test/.test(st) && /표본 적음/.test(st) && /표본 적은 제목 숨기기/.test(st), "toggle shows small samples tagged");
  await page.close();
}
{
  const { page } = await mk("ko", Object.assign({}, DATA, { inhouseChecked: false }));
  ck(/협업 시트를 제때 읽지 못해/.test(await page.innerText("#body")), "in-house not checked notice");
  await page.close();
}
for (const lang of ["en", "vi"]) {
  const { page } = await mk(lang, Object.assign({}, DATA, { inhouseChecked: false }));
  await page.waitForTimeout(300);
  const t = await page.innerText("#body") + "\n" + await page.innerText(".tabs");
  const left = (t.match(/[^\n]*[가-힣][^\n]*/g) || []);
  ck(!left.length, lang + " untranslated: " + left.join(" | "));
  await page.close();
}
console.log(`\n${ok} passed, ${bad} failed`);
await browser.close(); process.exit(bad ? 1 : 0);
