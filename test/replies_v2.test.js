// 테스트: 회신 판별 v2 — 모든 폴더·참조·숨은참조, 메일함 주인 귀속
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
    case "HSET": { const h = hashes.get(k) || new Map(); h.set(a[2], a[3]); hashes.set(k, h); return 1; }
    case "HGET": { const h = hashes.get(k); return h && h.has(a[2]) ? h.get(a[2]) : null; }
    case "HMGET": { const h = hashes.get(k); return a.slice(2).map(f => (h && h.has(f)) ? h.get(f) : null); }
    case "HLEN": { const h = hashes.get(k); return h ? h.size : 0; }
    case "HGETALL": { const h = hashes.get(k); const out = []; if (h) h.forEach((v, f) => out.push(f, v)); return out; }
    case "HDEL": { const h = hashes.get(k); return h && h.delete(a[2]) ? 1 : 0; }
    case "SADD": { const s = sets.get(k) || new Set(); s.add(a[2]); sets.set(k, s); return 1; }
    case "SMEMBERS": return [...(sets.get(k) || [])];
    case "SISMEMBER": return (sets.get(k) || new Set()).has(a[2]) ? 1 : 0;
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


const H = require("../history.js");
const M = require("../mail.js");
const S = require("../sync.js");
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const P = e => ({ name: "", email: e });
const acct = { email: "jinwon.choi@dalba.com", name: "Jinwon", appPassword: "x" };

// ── Sent folder ──
let SENT = [
  { uid: 1, messageId: "s1", at: "2026-05-10T00:00:00Z", subject: "collab", toAll: [1,2,3,4,5,6,7,8].map(i => P("c"+i+"@gmail.com")), ccAll: [], bccAll: [] },
  { uid: 2, messageId: "s2", at: "2026-05-11T00:00:00Z", subject: "collab", toAll: [P("c9@gmail.com")], ccAll: [], bccAll: [P("c10@gmail.com")] },
  { uid: 3, messageId: "s3", at: "2026-05-12T00:00:00Z", subject: "internal", toAll: [P("minju.kim@dalba.com")], ccAll: [], bccAll: [] },
];
SENT.forEach(m => { m.to = m.toAll[0]; m.from = P(acct.email); });
let SENT_BATCH = 1;   // simulate budget: 1 message per read call
M.read = async (a, o) => {
  let uids = SENT.map(m => m.uid).sort((x, y) => x - y);
  if (o.minUid) uids = uids.filter(u => u > o.minUid);
  const take = uids.slice(-(o.limit || 2000));
  const got = take.slice(0, SENT_BATCH).map(u => SENT.find(m => m.uid === u));
  return { path: "Sent", rows: got, total: take.length, truncated: take.length > got.length };
};
// ── Reply folders ──
let BOXES = {
  INBOX: [
    { uid: 10, messageId: "r1", at: "2026-05-20T00:00:00Z", subject: "Re: collab", from: P("c1@gmail.com") },       // bulk recipient
    { uid: 11, messageId: "r9", at: "2026-05-21T00:00:00Z", subject: "Re: collab", from: P("c9@gmail.com") },       // logged
    { uid: 12, messageId: "r10", at: "2026-05-22T00:00:00Z", subject: "Re: collab", from: P("c10@gmail.com") },     // bcc
    { uid: 13, messageId: "rx", at: "2026-05-23T00:00:00Z", subject: "Hi brand", from: P("stranger@gmail.com") },   // never emailed
    { uid: 14, messageId: "rm", at: "2026-05-23T00:00:00Z", subject: "meeting", from: P("minju.kim@dalba.com") },   // coworker
    { uid: 15, messageId: "r11", at: "2026-05-24T00:00:00Z", subject: "Re: hello", from: P("c11@gmail.com") },      // contacted by luna (log)
  ],
  "크리에이터": [
    { uid: 3, messageId: "r2", at: "2026-05-25T00:00:00Z", subject: "Re: collab", from: P("c2@gmail.com") },        // filed by rule
  ]
};
M.readFolders = async (a, o) => ({ folders: Object.keys(BOXES).map(path => {
  const min = Number((o.cursors || {})[path]) || 0;
  const rows = BOXES[path].filter(m => m.uid > min).map(m => Object.assign({ toAll: [], ccAll: [] }, m));
  return { path, name: path, rows, total: rows.length, truncated: false, skipped: false };
}) });

(async () => {
  // folder filter
  ck(M.isReplyFolder({ path: "INBOX" }), "INBOX scanned");
  ck(M.isReplyFolder({ path: "크리에이터", name: "크리에이터" }), "custom folder scanned");
  ck(!M.isReplyFolder({ path: "Sent Messages", name: "Sent Messages", specialUse: "\\Sent" }), "Sent skipped");
  ck(!M.isReplyFolder({ path: "스팸편지함", name: "스팸편지함" }), "spam skipped");
  ck(!M.isReplyFolder({ path: "Trash", name: "Trash", specialUse: "\\Trash" }), "trash skipped");
  ck(!M.isReplyFolder({ path: "[Gmail]", name: "[Gmail]", flags: new Set(["\\Noselect"]) }), "noselect skipped");

  // luna contacted c11 via the tool
  await H.log({ to: "c11@gmail.com", handle: "", at: "2026-05-15T00:00:00Z", by: "luna@dalbausa.com", byName: "Luna" });
  const replyCount = () => (lists.get("outreach:replies") || []).length;
  const until = () => Date.now() + 60e3;

  // run 1: sent backfill truncated (1 msg / call) → but loop continues while time left → finishes; verify then replies recorded
  let contacted = await S.contactedMap();
  const r1 = await S.syncAccount(acct, contacted, { until: Date.now() + 60e3 });
  ck(!r1.replies.waiting, "sent-to backfill completed within budget loop");
  const recs = (lists.get("outreach:replies") || []).map(x => JSON.parse(x));
  const froms = new Set(recs.map(r => r.from));
  ck(["c1@gmail.com","c2@gmail.com","c9@gmail.com","c10@gmail.com","c11@gmail.com"].every(e => froms.has(e)), "recorded bulk/bcc/folder/logged replies: " + [...froms].join(","));
  ck(!froms.has("stranger@gmail.com") && !froms.has("minju.kim@dalba.com"), "stranger & coworker not recorded");
  ck(recs.every(r => r.inbox === acct.email && r.by === acct.email), "credited to jinwon's mailbox");
  ck(recs.find(r => r.from === "c2@gmail.com").box === "크리에이터", "folder recorded");
  ck(r1.replies.found === 5 && r1.replies.notContacted === 1, "found 5, notContacted 1: " + JSON.stringify(r1.replies));
  // c1 (bulk) must NOT enter the dedup log
  const logTo = (lists.get("outreach:log") || []).map(x => JSON.parse(x).to);
  ck(!logTo.includes("c1@gmail.com"), "bulk recipients not added to dedup log");

  // ── address books after run 1 ──
  const sb = Object.fromEntries((await H.bookAll("sent", acct.email)).map(b => [b.email, b]));
  ck([1,2,3,4,5,6,7,8,9,10].every(i => sb["c"+i+"@gmail.com"]), "sent book has bulk (8) + to + bcc: " + Object.keys(sb).join(","));
  ck(!sb["minju.kim@dalba.com"], "sent book excludes internal");
  ck(sb["c1@gmail.com"].n === 1 && sb["c1@gmail.com"].subj === "collab" && sb["c1@gmail.com"].first.startsWith("2026-05-10"), "sent book metadata");
  const rb = Object.fromEntries((await H.bookAll("recv", acct.email)).map(b => [b.email, b]));
  ck(["c1","c2","c9","c10","c11"].every(x => rb[x+"@gmail.com"]) && rb["stranger@gmail.com"], "recv book has replies + stranger");
  ck(!rb["minju.kim@dalba.com"], "recv book excludes coworker");
  ck(rb["c2@gmail.com"].box === "크리에이터" && rb["stranger@gmail.com"].n === 1, "recv book folder + count");

  // run 2: nothing new → no duplicates
  const n = replyCount();
  const r2 = await S.syncAccount(acct, await S.contactedMap(), { until: Date.now() + 60e3 });
  ck(replyCount() === n && r2.replies.found === 0, "incremental: no re-record");

  // new reply arrives in INBOX from c3 (bulk recipient)
  BOXES.INBOX.push({ uid: 16, messageId: "r3", at: "2026-06-01T00:00:00Z", subject: "Re: collab", from: P("c3@gmail.com") });
  const r3 = await S.syncAccount(acct, await S.contactedMap(), { until: Date.now() + 60e3 });
  ck(r3.replies.found === 1 && replyCount() === n + 1, "new reply picked up");
  const rb2 = Object.fromEntries((await H.bookAll("recv", acct.email)).map(b => [b.email, b]));
  const sb2 = Object.fromEntries((await H.bookAll("sent", acct.email)).map(b => [b.email, b]));
  ck(rb2["c1@gmail.com"].n === 1 && rb2["c3@gmail.com"].n === 1 && sb2["c1@gmail.com"].n === 1, "re-runs do not double count");
  // new sent mail to c1 again → sent count 2
  SENT.push({ uid: 4, messageId: "s4", at: "2026-06-03T00:00:00Z", subject: "follow up", toAll: [P("c1@gmail.com")], ccAll: [], bccAll: [], to: P("c1@gmail.com"), from: P(acct.email) });
  SENT_BATCH = 10;
  await S.syncAccount(acct, await S.contactedMap(), { until: Date.now() + 60e3 });
  const sb3 = Object.fromEntries((await H.bookAll("sent", acct.email)).map(b => [b.email, b]));
  ck(sb3["c1@gmail.com"].n === 2 && sb3["c1@gmail.com"].subj === "follow up" && sb3["c1@gmail.com"].last.startsWith("2026-06-03"), "sent book increments with latest subject");

  // waiting behaviour: brand-new account with tiny budget → replies deferred, cursors not advanced
  const acct2 = { email: "luna@dalbausa.com", name: "Luna", appPassword: "x" };
  SENT_BATCH = 1;
  const w = await S.syncAccount(acct2, await S.contactedMap(), { until: Date.now() + 1000 });
  ck(w.replies.waiting === true, "replies deferred until sent backfill done");
  ck(!kv.has("outreach:cursor:box3:luna@dalbausa.com"), "box cursor untouched while waiting");

  // manual collect path (no cursor) still dedups
  const m = await S.collectReplies(acct, await S.contactedMap(), { since: "2026-05-01", limit: 20000, budgetMs: 5000 });
  ck(m.found === 0 && m.duplicate === 6, "manual rescan dedups: " + JSON.stringify({ f: m.found, d: m.duplicate }));

  // ── diagnose endpoint ──
  process.env.NW_ACCOUNTS = JSON.stringify([
    { id: "jinwon", pw: "x", appPassword: "y", email: "jinwon.choi@dalba.com", name: "Jinwon" },
    { id: "luna", pw: "x", appPassword: "y", email: "luna@dalbausa.com", name: "Luna" }]);
  process.env.ADMIN_EMAILS = "jinwon.choi@dalba.com";
  const A = require("../auth.js");
  BOXES.INBOX.push({ uid: 17, messageId: "r4", at: "2026-06-02T00:00:00Z", subject: "Re: collab", from: P("c4@gmail.com") }); // pending (not collected yet)
  const api = require("../api/replies.js");
  const call = (req, user) => new Promise(res => { A.currentUser = () => user; const r = { _s: 0, setHeader() {}, status(s) { this._s = s; return this; }, json(o) { res({ status: this._s, body: o }); } }; api(Object.assign({ headers: {}, query: {} }, req), r); });
  const d = await call({ method: "GET", query: { diagnose: "1", user: "jinwon.choi@dalba.com" } }, { email: "jinwon.choi@dalba.com", name: "Jinwon" });
  ck(d.status === 200, "diagnose 200 " + JSON.stringify(d.body).slice(0, 150));
  const st = Object.fromEntries((d.body.rows || []).map(r => [r.email, r.status]));
  ck(st["c4@gmail.com"] === "pending", "c4 pending");
  ck(st["c1@gmail.com"] === "recorded" && st["c2@gmail.com"] === "recorded", "c1/c2 recorded");
  ck(st["stranger@gmail.com"] === "not-contacted", "stranger not-contacted");
  ck(!("minju.kim@dalba.com" in st), "coworker excluded");
  ck(d.body.pending === 1 && d.body.notContacted === 1 && d.body.sentToDone === true, "summary counts " + JSON.stringify({ p: d.body.pending, n: d.body.notContacted, done: d.body.sentToDone }));
  const denied = await call({ method: "GET", query: { diagnose: "1", user: "jinwon.choi@dalba.com" } }, { email: "luna@dalbausa.com", name: "Luna" });
  ck(denied.status === 403, "non-admin cannot diagnose others");
  const own = await call({ method: "GET", query: { diagnose: "1", user: "luna@dalbausa.com" } }, { email: "luna@dalbausa.com", name: "Luna" });
  ck(own.status === 200, "own mailbox diagnose allowed");
  // "지금 다시 수집" picks up c4
  const col = await call({ method: "POST", body: { user: "jinwon.choi@dalba.com" } }, { email: "jinwon.choi@dalba.com", name: "Jinwon" });
  ck(col.status === 200 && col.body.totals.found === 1, "recollect found 1 " + JSON.stringify(col.body.totals));

  // ── admin API: 📒 주소록 ──
  await H.log({ to: "tooluser@x.com", handle: "@toolie", name: "Tool User", at: "2026-06-04T00:00:00Z", by: "jinwon.choi@dalba.com", byName: "Jinwon", campaign: "Tool camp" });
  await H.log({ to: "c1@gmail.com", at: "2026-06-05T00:00:00Z", by: "jinwon.choi@dalba.com", byName: "Jinwon", campaign: "Tool again" });
  const admin = require("../api/admin.js");
  const aCall = q => new Promise(res => { A.currentUser = () => ({ email: "jinwon.choi@dalba.com", name: "Jinwon" }); const r = { _s: 0, setHeader() {}, status(x) { this._s = x; return this; }, json(o) { res({ status: this._s, body: o }); } }; admin({ method: "GET", headers: {}, query: q }, r); });
  const bs = await aCall({ view: "book", dir: "sent", by: "jinwon.choi@dalba.com" });
  const bsm = Object.fromEntries((bs.body.rows || []).map(r => [r.email, r]));
  ck(bs.status === 200 && bsm["tooluser@x.com"] && bsm["tooluser@x.com"].src.join() === "tool" && bsm["tooluser@x.com"].handle === "toolie", "book sent: tool-only send included");
  ck(bsm["c1@gmail.com"].src.join() === "mailbox,tool" && bsm["c1@gmail.com"].n === 3 && !("subj" in bsm["c1@gmail.com"]), "book sent: mailbox+tool merged " + JSON.stringify(bsm["c1@gmail.com"]));
  const br = await aCall({ view: "book", dir: "recv", by: "jinwon.choi@dalba.com" });
  const brm = Object.fromEntries((br.body.rows || []).map(r => [r.email, r]));
  ck(brm["c1@gmail.com"].emailed === true && brm["stranger@gmail.com"].emailed === false, "book recv: emailed flag");
  const bq = await aCall({ view: "book", dir: "recv", by: "jinwon.choi@dalba.com", q: "stranger" });
  ck((bq.body.rows || []).length === 1, "book search filter");
  const ball = await aCall({ view: "book", dir: "sent" });
  ck((ball.body.rows || []).some(r => r.staff === "jinwon.choi@dalba.com" && r.staffName === "Jinwon"), "book all-staff has staff name");

  // parallelism: slow Redis (contactedMap) + slow IMAP should overlap, not add up
  const realRF = M.readFolders, realCM = S.contactedMap;
  let rfBudget = 0;
  M.readFolders = async (a, o) => { rfBudget = o.budgetMs; await new Promise(r => setTimeout(r, 400)); return realRF(a, o); };
  S.contactedMap = async () => { await new Promise(r => setTimeout(r, 400)); return realCM(); };
  const t1 = Date.now();
  const d2 = await call({ method: "GET", query: { diagnose: "1", user: "jinwon.choi@dalba.com" } }, { email: "jinwon.choi@dalba.com", name: "Jinwon" });
  const el = Date.now() - t1;
  ck(d2.status === 200 && el < 750, "diagnose overlaps Redis+IMAP (" + el + "ms)");
  ck(rfBudget > 30000 && rfBudget <= 40000, "IMAP budget derived from request start (" + rfBudget + ")");
  M.readFolders = realRF; S.contactedMap = realCM;

  console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch(e => { console.log("THREW", e && e.stack || e); process.exit(1); });
