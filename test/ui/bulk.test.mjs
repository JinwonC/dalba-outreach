// 화면 테스트: 대량 붙여넣기 파싱 — 핸들·이름·이메일 칸 인식, 발송 요청에 핸들 포함
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import fs from "fs"; import path from "path";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const page = await browser.newPage();
page.on("pageerror", e => { if (/sandboxed/.test(e.message)) return; bad++; console.log("PAGEERROR", e.message); });
await page.addInitScript(() => { try { localStorage.setItem("nwtoken","t"); localStorage.setItem("outreach_lang","ko"); } catch(_){} });
let posted = null;
await page.route("**/*", async route => {
  const u = new URL(route.request().url()); const m = route.request().method();
  const json = o => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
  if (u.pathname === "/api/login") return json({ mode: "accounts" });
  if (u.pathname === "/api/outreach-send" && m === "GET") return json({ me: { email: "luna@dalbausa.com", name: "Luna" }, admin: false, history: { enabled: true } });
  if (u.pathname === "/api/outreach-send" && m === "POST") { posted = JSON.parse(route.request().postData()); return json({ results: posted.recipients.map(r => ({ to: r.to, ok: true })), sent: posted.recipients.length }); }
  if (u.pathname.startsWith("/api/")) return json({});
  const f = path.join(ROOT, u.pathname);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ status: 200, contentType: f.endsWith(".js") ? "application/javascript" : "text/html", body: fs.readFileSync(f) });
  return route.fulfill({ status: 404, body: "" });
});
await page.goto("http://app.local/index.html");
await page.waitForFunction(() => typeof ME !== "undefined" && ME && ME.email);
await page.evaluate(() => setMode("bulk"));

const parse = txt => page.evaluate(t => { document.getElementById("bulkText").value = t; return parseBulk().rows; }, txt);
const T = "\t";
let r;
r = await parse(["Email","Name","TikTok Handle"].join(T)+"\n"+["yaniratipsparati@gmail.com","Yanira M. Ferreira","@yaniratips"].join(T));
ck(r[0].handle === "yaniratips" && r[0].creatorName === "Yanira M. Ferreira", "A header+handle col: " + JSON.stringify(r[0]));
r = await parse(["yaniratipsparati@gmail.com","Yanira M. Ferreira","yaniratips"].join(T));
ck(r[0].handle === "yaniratips" && r[0].creatorName === "Yanira M. Ferreira", "B NO header keeps handle: " + JSON.stringify(r[0]));
r = await parse(["yaniratips","yaniratipsparati@gmail.com"].join(T));
ck(r[0].handle === "yaniratips", "C no header, handle first: " + JSON.stringify(r[0]));
r = await parse(["크리에이터명","이메일"].join(T)+"\n"+["yaniratips","yaniratipsparati@gmail.com"].join(T));
ck(r[0].handle === "yaniratips", "D handle inside 크리에이터명 column: " + JSON.stringify(r[0]));
r = await parse(["Email","Name","TikTok Link"].join(T)+"\n"+["y@gmail.com","Yan","https://www.tiktok.com/@yaniratips?lang=en"].join(T));
ck(r[0].handle === "yaniratips", "E TikTok URL column: " + JSON.stringify(r[0]));
r = await parse(["Name","Email","주소"].join(T)+"\n"+["Jason Choi","jason@x.com","123 Main St"].join(T));
ck(r.length === 1 && r[0].to === "jason@x.com", "F 주소 column does not overwrite email: " + JSON.stringify(r));
r = await parse(["Email","Name","Profile Name"].join(T)+"\n"+["a@b.com","J","Jason Choi"].join(T));
ck(!r[0].handle, "G name-like value in handle column is not a handle: " + JSON.stringify(r[0]));
r = await parse(["jason@x.com","Jason"].join(T));
ck(!r[0].handle && r[0].creatorName === "Jason", "H capitalized name stays name");
r = await parse(["mia@x.com","mia"].join(T));
ck(!r[0].handle, "I short lowercase name not a handle");
r = await parse(["a@b.com","Ann Lee","@annlee","500","20%"].join(T));
ck(r[0].handle === "annlee" && r[0].creatorName === "Ann Lee", "J numbers ignored, @handle kept");
r = await parse(["mama_peyy","peytonpw23@gmail.com"].join(T));
ck(r[0].handle === "mama_peyy", "K underscore handle recognised");

// bulk info shows handles-missing count
await page.evaluate(() => { document.getElementById("bulkText").value = "a@b.com\tJason\nc@d.com\tAnn\t@ann_x"; renderBulkTable(); });
const info = await page.innerText("#bulkInfo");
ck(/핸들 없음 1명/.test(info), "bulk info shows 핸들 없음 1명: " + info);

// the actual send request carries the handle
await page.evaluate(() => { document.getElementById("bulkText").value = "yaniratipsparati@gmail.com\tYanira M. Ferreira\tyaniratips\nfoo@bar.com\tFoo Bar\thttps://www.tiktok.com/@foo.bar"; });
await page.evaluate(() => doSend(recipients()));
await page.waitForFunction(() => true);
await page.waitForTimeout(300);
ck(posted && posted.recipients.length === 2, "send posted 2 recipients");
ck(posted && posted.recipients[0].handle === "yaniratips" && posted.recipients[1].handle === "foo.bar", "send request carries handles: " + JSON.stringify(posted && posted.recipients.map(x => x.handle)));

// translation of the new bulk info text
for (const lang of ["en","vi"]) {
  await page.evaluate(l => I18N.setLang(l), lang);
  await page.evaluate(() => { document.getElementById("bulkText").value = "a@b.com\tJason\nc@d.com\tAnn\t@ann_x"; renderBulkTable(); });
  await page.waitForTimeout(150);
  const left = await page.evaluate(() => { const o=[]; const w=document.createTreeWalker(document.getElementById("bulkInfo"),NodeFilter.SHOW_TEXT); let n; while((n=w.nextNode())){ if(/[가-힣]/.test(n.nodeValue)) o.push(n.nodeValue.trim()); } return o; });
  ck(left.length === 0, lang + " bulk info untranslated: " + JSON.stringify(left));
}
console.log(`\n${ok} passed, ${bad} failed`);
await browser.close(); process.exit(bad ? 1 : 0);
