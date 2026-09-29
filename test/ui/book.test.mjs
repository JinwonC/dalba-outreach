// 화면 테스트: 관리자 📒 주소록 — 내용·제목 없이 목록, 페이지 넘김, CSV
import { chromium } from "playwright";
import { fileURLToPath } from "url";
import fs from "fs"; import path from "path";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const ap = await browser.newPage({ acceptDownloads: true });
ap.on("pageerror", e => { if (/sandboxed/.test(e.message)) return; bad++; console.log("PAGEERROR", e.message); });
await ap.addInitScript(() => { try { localStorage.setItem("nwtoken","t"); localStorage.setItem("outreach_lang","ko"); } catch(_){} });
const dirs = []; let fillCalls = 0; const offsets = [];
await ap.route("**/*", async route => {
  const u = new URL(route.request().url());
  const json = o => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(o) });
  const base = { historyEnabled: true, me: { email: "jinwon.choi@dalba.com", name: "Jinwon" }, accounts: [{ email: "jinwon.choi@dalba.com", name: "Jinwon" }] };
  if (u.pathname === "/api/replies" && route.request().method() === "POST") {
    fillCalls++;
    const seq = [{ results: [{ waiting: true }] }, { results: [{ folders: [{ path: "INBOX", truncated: true }] }] }, { results: [{ folders: [{ path: "INBOX", truncated: false }] }] }];
    return json(seq[Math.min(fillCalls - 1, 2)]);
  }
  if (u.pathname === "/api/admin" && u.searchParams.get("view") === "book" && u.searchParams.get("dir") === "recv" && u.searchParams.get("pageSize") === "5000") {
    // CSV export gathers pages
    const off = Number(u.searchParams.get("offset")); offsets.push(off);
    const all = [{ email: "stranger@gmail.com", staff: "jinwon.choi@dalba.com", n: 1, emailed: false, box: "INBOX" }, { email: "c2@gmail.com", staff: "jinwon.choi@dalba.com", n: 2, emailed: true, box: "INBOX" }, { email: "p3@gmail.com", staff: "jinwon.choi@dalba.com", n: 1, emailed: false, box: "INBOX" }];
    return json(Object.assign({}, base, { dir: "recv", rows: all.slice(off, off + 2), total: 3, offset: off, hasMore: off + 2 < 3 }));
  }
  if (u.pathname === "/api/admin" && u.searchParams.get("view") === "book") {
    const dir = u.searchParams.get("dir"); dirs.push(dir);
    if (dir === "replied") return json(Object.assign({}, base, { dir, status: [], rows: [
      { email: "c2@gmail.com", name: "C2", handle: "ctwo", staff: "jinwon.choi@dalba.com", staffName: "Jinwon", n: 2, first: "2026-05-25T00:00:00Z", last: "2026-05-26T00:00:00Z", box: "크리에이터", emailed: true }] }));
    return json(Object.assign({}, base, { dir, msgUsage: { usedMB: 12.5, capMB: 150, full: false }, status: [{ staff: "jinwon.choi@dalba.com", staffName: "Jinwon", sentBook: 7, recvBook: 4, messages: 321, at: "2026-09-24T10:00:00Z", sentFolder: "보낸 메일함", sentCaughtUp: true, foldersCaughtUp: false }], rows: dir === "sent"
      ? [{ email: "c1@gmail.com", name: "C1", handle: "cone", staff: "jinwon.choi@dalba.com", staffName: "Jinwon", n: 3, first: "2026-05-10T00:00:00Z", last: "2026-06-05T00:00:00Z", subj: "Tool again, \"quoted\"", src: ["mailbox","tool"] },
         { email: "t@x.com", name: "", staff: "jinwon.choi@dalba.com", staffName: "Jinwon", n: 1, first: "2026-06-04T00:00:00Z", last: "2026-06-04T00:00:00Z", subj: "Tool camp", src: ["tool"] }]
      : [{ email: "stranger@gmail.com", name: "S", staff: "jinwon.choi@dalba.com", staffName: "Jinwon", n: 1, first: "2026-05-23T00:00:00Z", last: "2026-05-23T00:00:00Z", subj: "Hi brand", box: "INBOX", emailed: false },
         { email: "c2@gmail.com", name: "C2", staff: "jinwon.choi@dalba.com", staffName: "Jinwon", n: 2, first: "2026-05-25T00:00:00Z", last: "2026-05-26T00:00:00Z", subj: "Re: collab", box: "크리에이터", emailed: true }] }));
  }
  if (u.pathname === "/api/admin") return json(Object.assign({}, base, { staff: [], totals: {} }));
  if (u.pathname.startsWith("/api/")) return json({ mode: "accounts", me: base.me, admin: true });
  const f = path.join(ROOT, u.pathname);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) return route.fulfill({ status: 200, contentType: f.endsWith(".js") ? "application/javascript" : "text/html", body: fs.readFileSync(f) });
  return route.fulfill({ status: 404, body: "" });
});
await ap.goto("http://app.local/admin.html");
await ap.waitForTimeout(500);
await ap.click("button.tab[data-v='book']");
await ap.waitForFunction(() => /c2@gmail\.com/.test(document.getElementById("body").innerText));
let t = await ap.innerText("#body");
ck(dirs[0] === "replied", "default dir=replied (회신 온 사람)");
t = await ap.innerText("#body");
ck(/c2@gmail\.com/.test(t) && /@ctwo/.test(t) && /회신 수/.test(t) && !/최근 제목/.test(t), "replied list: address/handle/count, no subject column");
const [dl0] = await Promise.all([ap.waitForEvent("download"), ap.click("button[onclick='exportBookCsv()']")]);
const csv0 = fs.readFileSync(await dl0.path(), "utf8");
ck(/Staff,Staff email,Address,Name,Handle,Replies,First reply,Last reply,Folder/.test(csv0) && !/subject/i.test(csv0) && /addresses_replied_all_/.test(dl0.suggestedFilename()), "replied CSV (no subject)");
await ap.click("button[onclick=\"setBookDir('sent')\"]");
await ap.waitForFunction(() => /c1@gmail\.com/.test(document.getElementById("body").innerText));
t = await ap.innerText("#body");
ck(/툴 발송/.test(t) && /메일함/.test(t) && /@cone/.test(t) && /Jinwon/.test(t), "sent table renders source tags, handle, staff col");
ck(!/Tool again|Tool camp|최근 제목/.test(t), "sent table shows no subjects");
const [dl] = await Promise.all([ap.waitForEvent("download"), ap.click("button[onclick='exportBookCsv()']")]);
const csv = fs.readFileSync(await dl.path(), "utf8");
ck(csv.charCodeAt(0) === 0xfeff && /Staff,Staff email,Address,Name,Handle,Messages,First,Last,Source/.test(csv) && !/subject/i.test(csv), "sent CSV header (English, BOM, no subject)");
ck(!/Tool again/.test(csv) && /Mailbox \+ Tool/.test(csv) && /@cone/.test(csv), "sent CSV has no subject, has source");
ck(/addresses_sent_all_/.test(dl.suggestedFilename()), "sent CSV filename " + dl.suggestedFilename());
await ap.click("button[onclick=\"setBookDir('recv')\"]");
await ap.waitForFunction(() => /stranger@gmail\.com/.test(document.getElementById("body").innerText));
t = await ap.innerText("#body");
ck(dirs[dirs.length-1] === "recv" && /✓ 회신/.test(t) && /크리에이터/.test(t) && !/Hi brand|Re: collab/.test(t), "recv table with emailed flag + folder, no subjects");
const [dl2] = await Promise.all([ap.waitForEvent("download"), ap.click("button[onclick='exportBookCsv()']")]);
const csv2 = fs.readFileSync(await dl2.path(), "utf8");
ck(offsets.join() === "0,2" && /p3@gmail\.com/.test(csv2), "CSV gathered all pages (offsets " + offsets.join() + ")");
ck(/Staff,Staff email,Address,Name,Handle,Messages,First,Last,Folder,We emailed them/.test(csv2) && !/Hi brand/.test(csv2) && /Yes \(reply\)/.test(csv2) && /,No\r?\n?/.test(csv2), "recv CSV");
ck(await ap.$("#body [data-thread-peer]") === null, "address book rows do NOT open mail content");
await ap.click("text=c2@gmail.com");
await ap.waitForTimeout(300);
ck(!(await ap.evaluate(() => { const m = document.getElementById("threadModal"); return m && getComputedStyle(m).display !== "none"; })), "clicking a row opens nothing");
// status table + one-click fill loop (3 calls: waiting → truncated → done)
await ap.click("summary");
t = await ap.innerText("#body");
ck(/보낸 메일함/.test(t) && /채우는 중/.test(t) && /321/.test(t) && /12\.5 \/ 150 MB/.test(t), "status table shows sent folder, filling, stored mail, DB usage");
await ap.selectOption("#by", "jinwon.choi@dalba.com");
await ap.waitForFunction(() => /c2@gmail\.com|stranger/.test(document.getElementById("body").innerText));
await ap.click("button[onclick='fillBook()']");
await ap.waitForFunction(() => /채우기 끝/.test((document.getElementById("bookFill")||{}).innerText || ""), null, { timeout: 15000 });
ck(fillCalls === 3, "fill loop repeated until done (" + fillCalls + " calls)");
ck(/완료 1명/.test(await ap.innerText("#bookFill")), "fill result: 완료 1명");
for (const lang of ["en","vi"]) {
  await ap.evaluate(l => I18N.setLang(l), lang);
  for (const d of ["replied","sent","recv"]) {
    await ap.evaluate(x => setBookDir(x), d);
    await ap.waitForTimeout(300);
    const left = await ap.evaluate(() => { const o=[]; const w=document.createTreeWalker(document.getElementById("body"),NodeFilter.SHOW_TEXT); let n; while((n=w.nextNode())){ const v=n.nodeValue.trim(); if(/[가-힣]/.test(v) && v !== "크리에이터" && v !== "보낸 메일함" && v !== "Jinwon") o.push(v);} 
      document.querySelectorAll(".tab").forEach(b => { if (/[가-힣]/.test(b.innerText)) o.push("TAB:"+b.innerText); }); return o; });
    ck(left.length === 0, lang + "/" + d + " untranslated: " + JSON.stringify(left));
  }
}
console.log(`\n${ok} passed, ${bad} failed`);
await browser.close(); process.exit(bad ? 1 : 0);
