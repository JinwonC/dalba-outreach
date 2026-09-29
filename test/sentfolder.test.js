// 테스트: 보낸편지함 폴더 찾기 (이름 변형·내용 기반, 못 찾으면 받은편지함으로 대체하지 않음)
require("./helpers/stubs");
const M = require("../mail.js");
const { ImapFlow } = require("imapflow");
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const me = n => ({ email: "staff" + n + "@dalba.com", appPassword: "x" });
const D = "2026-06-01T00:00:00Z";
const mine = (n, k) => Array.from({ length: k }, (_, i) => ({ uid: i + 1, id: "m" + i, date: D, subject: "hi", from: "staff" + n + "@dalba.com", to: ["c" + i + "@gmail.com"] }));
const theirs = k => Array.from({ length: k }, (_, i) => ({ uid: i + 1, id: "t" + i, date: D, subject: "re", from: "c" + i + "@gmail.com", to: ["x@dalba.com"] }));
(async () => {
  const run = async (n, boxes, msgs) => { global.FAKE = { boxes, msgs }; return M.findMailbox(new ImapFlow(), "sent", me(n)); };
  ck(await run(1, [{ path: "INBOX", name: "INBOX" }, { path: "Sent", name: "Sent", specialUse: "\\Sent" }], { INBOX: theirs(3), Sent: mine(1, 3) }) === "Sent", "\\Sent flag");
  ck(await run(2, [{ path: "INBOX", name: "INBOX" }, { path: "보낸 메일함", name: "보낸 메일함" }], { INBOX: theirs(3), "보낸 메일함": mine(2, 3) }) === "보낸 메일함", "name with space");
  ck(await run(3, [{ path: "INBOX", name: "INBOX" }, { path: "INBOX/Sent Mail", name: "Sent Mail" }], { INBOX: theirs(3), "INBOX/Sent Mail": mine(3, 3) }) === "INBOX/Sent Mail", "nested Sent Mail");
  ck(await run(4, [{ path: "INBOX", name: "INBOX" }, { path: "발신함", name: "발신함" }, { path: "크리에이터", name: "크리에이터" }], { INBOX: theirs(5), "발신함": mine(4, 20), "크리에이터": theirs(4) }) === "발신함", "detected by content (from = me)");
  let err = "";
  try { await run(5, [{ path: "INBOX", name: "INBOX" }, { path: "크리에이터", name: "크리에이터" }], { INBOX: theirs(3), "크리에이터": theirs(3) }); } catch (e) { err = e.message; }
  ck(/보낸편지함 폴더를 찾지 못했습니다/.test(err) && /크리에이터/.test(err), "no sent folder → clear error, not INBOX: " + err);

  // read(kind:sent) uses detected folder; readFolders skips it even with an odd name
  global.FAKE = { boxes: [{ path: "INBOX", name: "INBOX" }, { path: "발신함", name: "발신함" }, { path: "크리에이터", name: "크리에이터" }, { path: "스팸메일함", name: "스팸메일함" }],
                  msgs: { INBOX: theirs(5), "발신함": mine(6, 20), "크리에이터": theirs(2), "스팸메일함": theirs(9) } };
  const r = await M.read(me(6), { kind: "sent", since: "2026-05-01", limit: 100 });
  ck(r.path === "발신함" && r.rows.length === 20 && r.rows[0].toAll.length === 1, "read sent → 발신함 (20 msgs)");
  const f = await M.readFolders(me(6), { since: "2026-05-01", limit: 100 });
  const paths = f.folders.map(x => x.path);
  ck(paths.includes("INBOX") && paths.includes("크리에이터") && !paths.includes("발신함") && !paths.includes("스팸메일함"), "readFolders folders: " + paths.join(","));
  // thread view: reply filed in 크리에이터 is shown
  global.FAKE.msgs["크리에이터"].push({ uid: 3, id: "x", date: D, subject: "Re: collab", from: "peer@gmail.com", to: ["staff6@dalba.com"] });
  const t = await M.readThread(me(6), { peer: "peer@gmail.com", since: "2026-05-01" });
  ck(t.rows.some(x => x.direction === "in" || x.dir === "in" || /collab/.test(JSON.stringify(x))), "thread includes reply from custom folder");
  console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch(e => { console.log("THREW", e.stack || e); process.exit(1); });
