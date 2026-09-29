// 테스트: 네이버웍스 단체·숨은참조 발송도 중복으로 잡는지 (보낸 주소록 대조, 1년 창)
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
    case "HSETNX": { const h = hashes.get(k) || new Map(); if (h.has(a[2])) return 0; h.set(a[2], a[3]); hashes.set(k, h); return 1; }
    case "INCRBY": { const v = (Number(kv.get(k)) || 0) + Number(a[2]); kv.set(k, String(v)); return v; }
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




process.env.NW_ACCOUNTS = JSON.stringify([
  { id: "jinwon", pw: "x", appPassword: "y", email: "jinwon.choi@dalba.com", name: "Jinwon" },
  { id: "luna", pw: "x", appPassword: "y", email: "luna@dalbausa.com", name: "Luna" }]);
process.env.ADMIN_EMAILS = "jinwon.choi@dalba.com";
const H = require("../history.js");
const S = require("../sync.js");
const A = require("../auth.js");
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const J = "jinwon.choi@dalba.com", L = "luna@dalbausa.com";
const day = d => new Date(Date.now() - d * 86400e3).toISOString();
(async () => {
  ck(H.WINDOW_DAYS === 365, "window default 365");
  // jinwon sent a GROUP mail (6 creators) + a BCC from NAVER WORKS webmail — only in his mailbox Sent folder
  let uid = 0;
  const m = (date, subject, to, bcc) => ({ uid: ++uid, id: "<g" + uid + ">", date, subject, from: J, to, bcc: bcc || [], body: "b" });
  global.FAKE = { boxes: [{ path: "INBOX", name: "INBOX" }, { path: "보낸 메일함", name: "보낸 메일함" }],
    msgs: { INBOX: [], "보낸 메일함": [
      m(day(130), "Group", ["g1@gmail.com","g2@gmail.com","g3@gmail.com","g4@gmail.com","g5@gmail.com","g6@gmail.com"]),
      m(day(10), "Duo", ["d1@gmail.com","d2@gmail.com"]),
    ] } };
  const accJ = A.findByEmail(J);
  const r = await S.syncAccount(accJ, await S.contactedMap(), { until: Date.now() + 60e3 });
  ck(!r.replies.waiting, "sync ok");

  // import pass: both recipients of a 2-person mail are now in the dedup log (was: first only)
  const logTo = (lists.get("outreach:log") || []).map(x => JSON.parse(x).to);
  ck(logTo.includes("d1@gmail.com") && logTo.includes("d2@gmail.com"), "2-recipient mail: both recipients recorded: " + logTo.join(","));
  ck(!logTo.includes("g1@gmail.com"), "group(6) mail stays out of the send log");

  // luna tries to email a group recipient (130 days ago — beyond old 90-day window) → BLOCKED via mailbox book
  const rv = await H.reserve({ to: "g3@gmail.com" }, { by: L, byName: "Luna" }, false);
  ck(rv.ok === false && rv.prior && rv.prior.by === J && rv.prior.source === "mailbox", "group/BCC recipient blocked for another staffer: " + JSON.stringify(rv.prior));
  ck(!kv.has("outreach:sent:e:g3@gmail.com"), "blocked attempt reserved nothing");
  // jinwon himself may follow up
  const self = await H.reserve({ to: "g3@gmail.com" }, { by: J, byName: "Jinwon" }, false);
  ck(self.ok === true, "own mailbox recipient → self follow-up allowed");
  // admin approval lets luna through
  await H.approveSend({ to: "g4@gmail.com" }, L, { approvedBy: J });
  ck((await H.reserve({ to: "g4@gmail.com" }, { by: L }, false)).ok === true, "approval passes book block");
  // force bypasses
  ck((await H.reserve({ to: "g5@gmail.com" }, { by: L }, true)).ok === true, "force bypasses");

  // pre-check (lookup) prefers the OTHER staffer when me is given
  await H.reserve({ to: "g6@gmail.com" }, { by: L, byName: "Luna" }, true);   // luna also has a key on g6
  const [pv] = await H.lookup([{ to: "g6@gmail.com" }], L);
  ck(pv && pv.by === J, "pre-check shows other staffer (jinwon), not self: " + JSON.stringify(pv));
  const [pv2] = await H.lookup([{ to: "g1@gmail.com" }]);
  ck(pv2 && pv2.by === J, "pre-check finds group recipient via mailbox");

  // window: an entry older than the window is not a block
  await H.bookMerge("sent", J, new Map([["ancient@gmail.com", { n: 1, first: day(400), last: day(400), subj: "", name: "", box: "" }]]));
  ck((await H.reserve({ to: "ancient@gmail.com" }, { by: L }, false)).ok === true, "older than 365 days → not blocked");

  // real send path: luna's tool send to g2 is held
  global.FAKE_NODEMAILER_MODULE = { exports: { createTransport: () => ({ verify: async () => true, sendMail: async () => ({ messageId: "<x>" }), close() {} }) } };
  const SC = require("../send-core.js");
  const IH = require("../inhouse.js"); IH.loadHandles = async () => ({ handles: new Set(), emails: new Map(), squashed: new Map() });
  const out = await SC.sendBatch({ account: { email: L, name: "Luna", password: "x" }, campaign: { subject: "Hi", pitch: "p", brand: "d'Alba", campaignTitle: "Test camp" }, recipients: [{ to: "g2@gmail.com", creatorName: "G2" }], admin: false });
  const res = (out.results || [])[0] || {};
  ck(res.ok === false && res.held === true && res.prior && res.prior.by === J, "send-core holds tool send to a webmail group recipient: " + JSON.stringify(res));

  // 🔎 lookup tool shows mailbox-only sends
  A.currentUser = () => ({ email: L, name: "Luna" });
  const lookup = require("../api/lookup.js");
  const lr = await new Promise(res2 => { const o = { _s: 0, setHeader() {}, status(x) { this._s = x; return this; }, json(b) { res2({ status: this._s, body: b }); } }; lookup({ method: "POST", headers: {}, query: {}, body: { queries: ["g1@gmail.com", "nobody@gmail.com"] } }, o); });
  const q = Object.fromEntries(lr.body.results.map(x => [x.query, x]));
  ck(q["g1@gmail.com"].found && q["g1@gmail.com"].senders.includes("Jinwon"), "🔎 shows group recipient as already sent by Jinwon");
  ck(!q["nobody@gmail.com"].found, "🔎 clean address stays clean");

  // rebuild v3 re-creates expired block keys from the log
  lists.get("outreach:log").push(JSON.stringify({ to: "old@gmail.com", at: day(120), by: J, byName: "Jinwon", campaign: "old" }));
  kv.delete("outreach:bridge:ver");
  ck(!kv.has("outreach:sent:e:old@gmail.com"), "old key absent (expired)");
  const rb = await H.rebuildBridge({ budgetMs: 5000 });
  ck(rb.done && kv.has("outreach:sent:e:old@gmail.com"), "rebuild re-blocks 120-day-old send under 365-day window");
  ck((await H.reserve({ to: "old@gmail.com" }, { by: L }, false)).ok === false, "and it now blocks");
  console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch(e => { console.log("THREW", e.stack || e); process.exit(1); });
