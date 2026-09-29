// 테스트: 가짜 IMAP 으로 동기화 전체 흐름 — 보낸/받은 주소록, 회신 판정, 메시지 저장
require("./helpers/stubs");
process.env.KV_REST_API_URL = "https://stub.local";
process.env.KV_REST_API_TOKEN = "stub";
process.env.NW_ACCOUNTS = JSON.stringify([
  { id: "seoyeon", pw: "x", appPassword: "y", email: "seoyeon@dalba.com", name: "Seoyeon" },
  { id: "luna", pw: "x", appPassword: "y", email: "luna@dalbausa.com", name: "Luna" },
  { id: "jinwon", pw: "x", appPassword: "y", email: "jinwon.choi@dalba.com", name: "Jinwon" }
]);
process.env.ADMIN_EMAILS = "jinwon.choi@dalba.com";

// ---- in-memory Upstash REST ----
const kv = new Map();          // string keys
const hashes = new Map();      // key -> Map
const sets = new Map();        // key -> Set
const lists = new Map();       // key -> array
function run1(a) {
  const op = String(a[0]).toUpperCase(), k = a[1];
  switch (op) {
    case "SET": { const nx = a.includes("NX"); if (nx && kv.has(k)) return null; kv.set(k, a[2]); return "OK"; }
    case "GET": return kv.has(k) ? kv.get(k) : null;
    case "MGET": return a.slice(1).map(x => kv.has(x) ? kv.get(x) : null);
    case "DEL": { const had = kv.delete(k) || hashes.delete(k) || sets.delete(k) || lists.delete(k); return had ? 1 : 0; }
    case "HSET": { const h = hashes.get(k) || new Map(); let n = 0; for (let i = 2; i + 1 < a.length; i += 2) { if (!h.has(a[i])) n++; h.set(a[i], a[i + 1]); } hashes.set(k, h); return n; }
    case "HGET": { const h = hashes.get(k); return h && h.has(a[2]) ? h.get(a[2]) : null; }
    case "HMGET": { const h = hashes.get(k); return a.slice(2).map(f => (h && h.has(f)) ? h.get(f) : null); }
    case "HLEN": { const h = hashes.get(k); return h ? h.size : 0; }
    case "HSETNX": { const h = hashes.get(k) || new Map(); if (h.has(a[2])) return 0; h.set(a[2], a[3]); hashes.set(k, h); return 1; }
    case "INCRBY": { const v = (Number(kv.get(k)) || 0) + Number(a[2]); kv.set(k, String(v)); return v; }
    case "HGETALL": { const h = hashes.get(k); const out = []; if (h) h.forEach((v, f) => out.push(f, v)); return out; }
    case "HDEL": { const h = hashes.get(k); let n = 0; if (h) for (let i = 2; i < a.length; i++) if (h.delete(a[i])) n++; return n; }
    case "SADD": { const s = sets.get(k) || new Set(); let n = 0; for (let i = 2; i < a.length; i++) if (!s.has(a[i])) { s.add(a[i]); n++; } sets.set(k, s); return n; }
    case "SMEMBERS": return [...(sets.get(k) || [])];
    case "SISMEMBER": return (sets.get(k) || new Set()).has(a[2]) ? 1 : 0;
    case "SMISMEMBER": { const s = sets.get(k) || new Set(); return a.slice(2).map(x => s.has(x) ? 1 : 0); }
    case "LPUSH": { const l = lists.get(k) || []; l.unshift(a[2]); lists.set(k, l); return l.length; }
    case "LTRIM": { const l = lists.get(k) || []; lists.set(k, l.slice(Number(a[2]), Number(a[3]) + 1)); return "OK"; }
    case "LRANGE": { const l = lists.get(k) || []; const e = Number(a[3]); return l.slice(Number(a[2]), e < 0 ? undefined : e + 1); }
    case "LLEN": return (lists.get(k) || []).length;
    case "EXPIRE": return 1;
    default: return null;
  }
}
global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  if (String(url).endsWith("/pipeline")) return { json: async () => body.map(c => ({ result: run1(c) })) };
  return { json: async () => ({ result: run1(body) }) };
};



process.env.NW_ACCOUNTS = JSON.stringify([{ id: "jinwon", pw: "x", appPassword: "y", email: "jinwon.choi@dalba.com", name: "Jinwon" }]);
process.env.ADMIN_EMAILS = "jinwon.choi@dalba.com";
const H = require("../history.js");
const S = require("../sync.js");
const A = require("../auth.js");
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const ME = "jinwon.choi@dalba.com";
const m = (uid, date, subject, from, to) => ({ uid, id: "<" + uid + subject + from + ">", date, subject, from, to, body: "BODY:" + subject + "\n\nOn Mon wrote:\n> quoted" });
// NAVER WORKS-like mailbox: Sent folder named "보낸 메일함" (space, no \Sent flag), custom folder, spam
global.FAKE = {
  boxes: [{ path: "INBOX", name: "INBOX" }, { path: "보낸 메일함", name: "보낸 메일함" }, { path: "크리에이터", name: "크리에이터" }, { path: "스팸메일함", name: "스팸메일함" }],
  msgs: {
    "보낸 메일함": [
      m(1, "2026-05-10T00:00:00Z", "Collab offer", ME, ["a@gmail.com", "b@gmail.com", "c@gmail.com", "d@gmail.com", "e@gmail.com", "f@gmail.com"]),  // group of 6 (skipped by dedup import)
      m(2, "2026-05-11T00:00:00Z", "Hello", ME, ["g@gmail.com"]),
      m(3, "2026-05-12T00:00:00Z", "internal", ME, ["minju.kim@dalba.com"]),
    ],
    INBOX: [
      m(1, "2026-05-20T00:00:00Z", "Re: Collab offer", "a@gmail.com", [ME]),
      m(2, "2026-05-21T00:00:00Z", "Re: Hello", "g@gmail.com", [ME]),
      m(3, "2026-05-22T00:00:00Z", "PR inquiry", "newbrand@agency.com", [ME]),   // inbound first contact
      m(4, "2026-05-23T00:00:00Z", "lunch", "minju.kim@dalba.com", [ME]),
    ],
    "크리에이터": [ m(1, "2026-05-24T00:00:00Z", "Re: Collab offer", "b@gmail.com", [ME]) ],
    "스팸메일함": [ m(1, "2026-05-25T00:00:00Z", "WIN", "spam@spam.com", [ME]) ]
  }
};
(async () => {
  // tool send logged earlier (SMTP → not in Sent folder)
  await H.log({ to: "tool@gmail.com", handle: "tooly", at: "2026-05-30T00:00:00Z", by: ME, byName: "Jinwon", campaign: "Tool camp" });
  const acct = A.findByEmail(ME);
  const r = await S.syncAccount(acct, await S.contactedMap(), { until: Date.now() + 60e3 });
  ck(!r.replies.waiting, "sync finished in one pass");
  const sent = Object.fromEntries((await H.bookAll("sent", ME)).map(x => [x.email, x]));
  ck(["a","b","c","d","e","f","g"].every(x => sent[x + "@gmail.com"]) && !sent["minju.kim@dalba.com"], "sent book from '보낸 메일함' incl. group of 6: " + Object.keys(sent).join(","));
  const recv = Object.fromEntries((await H.bookAll("recv", ME)).map(x => [x.email, x]));
  ck(recv["a@gmail.com"] && recv["g@gmail.com"] && recv["b@gmail.com"] && recv["newbrand@agency.com"], "recv book: replies + folder + inbound first contact");
  ck(!recv["spam@spam.com"] && !recv["minju.kim@dalba.com"] && !recv[ME], "recv book excludes spam, coworker, self");
  ck(recv["b@gmail.com"].box === "크리에이터", "folder kept");
  const reps = (lists.get("outreach:replies") || []).map(x => JSON.parse(x).from);
  ck(reps.includes("a@gmail.com") && reps.includes("b@gmail.com") && reps.includes("g@gmail.com") && !reps.includes("newbrand@agency.com"), "replies: group/folder/single recorded, inbound-first not a reply: " + reps.join(","));
  const info = await H.syncInfo(ME);
  ck(info && info.sentFolder === "보낸 메일함" && info.sentCaughtUp && info.foldersCaughtUp, "sync info: " + JSON.stringify(info));

  // admin view
  const admin = require("../api/admin.js");
  A.currentUser = () => ({ email: ME, name: "Jinwon" });
  const call = q => new Promise(res => { const o = { _s: 0, setHeader() {}, status(x) { this._s = x; return this; }, json(b) { res({ status: this._s, body: b }); } }; admin({ method: "GET", headers: {}, query: q }, o); });
  const bs = await call({ view: "book", dir: "sent", by: ME });
  const rows = Object.fromEntries(bs.body.rows.map(x => [x.email, x]));
  ck(rows["tool@gmail.com"] && rows["tool@gmail.com"].src.join() === "tool" && rows["a@gmail.com"].src.join() === "mailbox", "book sent: mailbox + tool");
  ck(rows["g@gmail.com"].n === 1, "imported-from-Sent send not double counted (n=" + rows["g@gmail.com"].n + ")");
  const st = bs.body.status[0];
  ck(st.sentFolder === "보낸 메일함" && st.sentBook === 7 && st.recvBook === 4, "status row: " + JSON.stringify(st));
  // imap fallback: an imported send whose address isn't in the book yet shows as mailbox
  await H.log({ to: "old@gmail.com", at: "2026-05-05T00:00:00Z", by: ME, byName: "Jinwon", campaign: "old", source: "imap" });
  const bs2 = await call({ view: "book", dir: "sent", by: ME });
  const old = bs2.body.rows.find(x => x.email === "old@gmail.com");
  ck(old && old.src.join() === "mailbox", "imap-imported send shown while book fills");
  // ── 📨 회신 온 사람 (주소록, 내용 없음) ──
  lists.get("outreach:replies").push(JSON.stringify({ from: "legacy@x.com", fromName: "Legacy", at: "2026-05-02T00:00:00Z", subject: "Re: old", inbox: ME, by: ME, box: "INBOX" }));
  const rp = await call({ view: "book", dir: "replied", by: ME });
  const rpm = Object.fromEntries(rp.body.rows.map(x => [x.email, x]));
  ck(rpm["a@gmail.com"] && rpm["b@gmail.com"] && rpm["g@gmail.com"], "replied list has repliers a/b/g");
  ck(!rpm["newbrand@agency.com"], "replied list excludes inbound first-contact");
  ck(rpm["legacy@x.com"] && rpm["legacy@x.com"].n === 1, "replied list backfilled from reply log");
  ck(rpm["b@gmail.com"].box === "크리에이터", "replied keeps folder");
  for (const dir of ["replied", "sent", "recv"]) {
    const rr = await call({ view: "book", dir, by: ME });
    ck(rr.body.rows.every(x => !("subj" in x)) && !/Collab offer|Re: Hello|PR inquiry|Tool camp|Re: old/.test(JSON.stringify(rr.body.rows)), dir + ": no subject/content in address book response");
  }
  const rs = await call({ view: "book", dir: "replied", by: ME, q: "Collab" });
  ck(rs.body.rows.length === 0, "search does not match on subject");

  // ── 메일 데이터베이스 (본문) ──
  const withA = await H.messagesWith(ME, "a@gmail.com");
  ck(withA.some(x => x.dir === "out" && x.subject === "Collab offer" && x.text === "BODY:Collab offer") &&
     withA.some(x => x.dir === "in" && x.subject === "Re: Collab offer" && x.text === "BODY:Re: Collab offer"), "stored both directions with body (quote stripped): " + JSON.stringify(withA.map(x => [x.dir, x.subject, x.text])));
  const withB = await H.messagesWith(ME, "b@gmail.com");
  ck(withB.some(x => x.box === "크리에이터" && x.dir === "in"), "stored reply from custom folder");
  ck((await H.messagesWith(ME, "newbrand@agency.com")).length === 1, "stored inbound first-contact too");
  ck((await H.messagesWith(ME, "spam@spam.com")).length === 0 && (await H.messagesWith(ME, "minju.kim@dalba.com")).length === 0, "no spam / internal stored");
  const cnt1 = await H.messageCount(ME);
  ck(cnt1 === 2 /*sent w/ external*/ + 4 /*in: a,g,newbrand + b*/, "message count " + cnt1);
  const bsx = await call({ view: "book", dir: "replied", by: ME });
  ck(!/BODY:/.test(JSON.stringify(bsx.body)), "address book response carries no body");
  ck(bsx.body.status[0].messages === cnt1 && bsx.body.msgUsage && bsx.body.msgUsage.capMB === 150, "status shows stored mail + usage: " + JSON.stringify(bsx.body.msgUsage));

  // re-run: nothing doubles
  await S.syncAccount(acct, await S.contactedMap(), { until: Date.now() + 60e3 });
  const sent2 = Object.fromEntries((await H.bookAll("sent", ME)).map(x => [x.email, x]));
  const recv2 = Object.fromEntries((await H.bookAll("recv", ME)).map(x => [x.email, x]));
  ck(sent2["a@gmail.com"].n === 1 && recv2["a@gmail.com"].n === 1, "second sync does not double count");
  ck(await H.messageCount(ME) === cnt1, "second sync stores no duplicate messages");
  // missing Sent folder → clear error saved to status
  global.FAKE.boxes = global.FAKE.boxes.filter(b => b.path !== "보낸 메일함");
  process.env.NW_ACCOUNTS = JSON.stringify([{ id: "x", pw: "x", appPassword: "y", email: "nosent@dalba.com", name: "NoSent" }]);
  let err = "";
  try { await S.syncAccount({ email: "nosent@dalba.com", name: "NoSent", appPassword: "y" }, new Map(), { until: Date.now() + 60e3 }); } catch (e) { err = e.message; }
  ck(/보낸편지함 폴더를 찾지 못했습니다/.test(err), "no Sent folder → error surfaced: " + err);
  console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch(e => { console.log("THREW", e.stack || e); process.exit(1); });
