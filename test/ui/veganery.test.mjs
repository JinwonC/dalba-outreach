// 화면 테스트: 🌿 Veganery 발송 탭 — 미리보기 로고·연두 색상, 브랜드별 초안·첨부 이미지, 발송 요청·확인창, 새로고침 유지, 번역
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import fs from "fs"; import path from "path";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const VEG = "data:image/png;base64," + fs.readFileSync(path.join(ROOT, "logo-veganery.png")).toString("base64");
const DAL = "data:image/png;base64," + fs.readFileSync(path.join(ROOT, "logo-black.png")).toString("base64");
async function mk(lang, ctx) {
  const context = ctx || await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", e => { if (/sandboxed/.test(e.message)) return; bad++; console.log("PAGEERROR", e.message); });
  await page.addInitScript(l => { try { localStorage.setItem("nwtoken","t"); localStorage.setItem("outreach_lang", l); } catch(_){} }, lang);
  const posts = [];
  await page.route("**/*", async route => {
    const u = new URL(route.request().url()); const m = route.request().method();
    const json = o => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
    if (u.pathname === "/api/login") return json({ mode: "accounts" });
    if (u.pathname === "/api/outreach-send" && m === "GET") return json({ me: { email: "luna@dalbausa.com", name: "Luna" }, admin: false, history: { enabled: true }, logoUrl: DAL, logos: { dalba: DAL, veganery: VEG } });
    if (u.pathname === "/api/outreach-send" && m === "POST") { const b = JSON.parse(route.request().postData()); posts.push(b); return json({ results: (b.recipients || []).map(r => ({ to: r.to, ok: true })), sent: (b.recipients || []).length, held: 0 }); }
    if (u.pathname === "/api/history" && m === "POST") { const b = JSON.parse(route.request().postData()); return json({ enabled: true, results: b.recipients.map(r => ({ to: r.to, prior: null })) }); }
    if (u.pathname.startsWith("/api/")) return json({});
    const f = path.join(ROOT, u.pathname);
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ status: 200, contentType: f.endsWith(".js") ? "application/javascript" : "text/html", body: fs.readFileSync(f) });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto("http://app.local/index.html");
  await page.waitForFunction(() => typeof ME !== "undefined" && ME && ME.email);
  await page.waitForTimeout(300);
  return { page, posts, context };
}
const VEG_URL = VEG;
const pv = page => page.$eval("#pv", e => e.srcdoc || "");
{
  const { page, posts, context } = await mk("ko");
  ck(await page.isVisible("#vtabVeganery") && !(await page.isVisible("#brandNote")), "tab visible, note hidden on d'Alba");
  ck((await pv(page)).includes("#f4c842") && (await pv(page)).includes(DAL.slice(0, 80)), "d'Alba preview: yellow + d'Alba logo");
  await page.fill("#product", "White Truffle Serum"); await page.evaluate(() => saveDraft());
  await page.click("#vtabVeganery");
  await page.waitForTimeout(400);
  let h = await pv(page);
  ck(h.includes("#8cc63f") && !h.includes("#f4c842") && h.includes(VEG.slice(0, 80)) && h.includes("height:58px"), "Veganery preview: green + Veganery logo");
  ck(await page.evaluate(() => document.getElementById("vtabVeganery").classList.contains("active") && !document.getElementById("vtabSend").classList.contains("active")), "Veganery tab active");
  ck(await page.isVisible("#brandNote"), "brand note shown");
  ck((await page.inputValue("#brand")) === "Veganery" && /💚/.test(await page.inputValue("#subject")), "brand + subject default for Veganery");
  ck((await page.inputValue("#product")) === "", "separate draft: d'Alba product not carried over");
  await page.fill("#product", "Vegan Cica Toner"); await page.evaluate(() => saveDraft());
  // 발송 요청에 테마가 실린다 + 확인창에 브랜드
  await page.fill("#to", "c@x.com"); await page.fill("#creatorName", "Cee"); await page.fill("#campaignTitle", "Green Launch");
  await page.evaluate(() => saveDraft());
  const camp = await page.evaluate(() => campaign());
  ck(camp.theme === "veganery" && camp.logoUrl === VEG_URL, "campaign payload: theme + Veganery logo");
  await page.evaluate(() => startSend());
  await page.waitForSelector("#confirmModal", { state: "visible" });
  const cb = await page.innerText("#confirmBody");
  ck(/🌿 Veganery/.test(cb), "confirm shows Veganery: " + cb.slice(0, 80));
  await page.click("#confirmGo");
  await page.waitForTimeout(500);
  ck(posts.length && posts[posts.length - 1].campaign && posts[posts.length - 1].campaign.theme === "veganery", "send request carries theme: " + JSON.stringify(posts.map(p => p.campaign && p.campaign.theme)));
  // d'Alba 로 돌아가면 d'Alba 초안
  await page.click("#vtabSend"); await page.waitForTimeout(300);
  ck((await page.inputValue("#product")) === "White Truffle Serum" && (await page.inputValue("#brand")) === "d'Alba" && /💛/.test(await page.inputValue("#subject")), "back to d'Alba draft");
  ck((await pv(page)).includes("#f4c842"), "d'Alba preview yellow again");
  await page.click("#vtabVeganery"); await page.waitForTimeout(300);
  ck((await page.inputValue("#product")) === "Vegan Cica Toner", "Veganery draft restored");
  await page.close();
  // 새로고침해도 Veganery 그대로
  const { page: p2 } = await mk("ko", context);
  ck(await p2.evaluate(() => THEME) === "veganery" && (await pv(p2)).includes("#8cc63f") && (await p2.inputValue("#product")) === "Vegan Cica Toner", "reload keeps Veganery tab + draft");
  await p2.close(); await context.close();
}
for (const lang of ["en", "vi"]) {
  const { page, context } = await mk(lang);
  await page.click("#vtabVeganery"); await page.waitForTimeout(400);
  const t = await page.innerText("#vtabVeganery") + "\n" + await page.innerText("#brandNote");
  const left = (t.match(/[^\n]*[가-힣][^\n]*/g) || []);
  ck(!left.length, lang + " untranslated: " + left.join(" | "));
  await page.close(); await context.close();
}
console.log(`\n${ok} passed, ${bad} failed`);
await browser.close(); process.exit(bad ? 1 : 0);
