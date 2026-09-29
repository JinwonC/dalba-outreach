// 테스트: 📥 답장 대기 — 회신했는데 아직 답하지 않은 대화 판정·권한
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
  { id: "luna", pw: "x", appPassword: "y", email: "luna@dalbausa.com", name: "Luna" },
  { id: "seoyeon", pw: "x", appPassword: "y", email: "seoyeon@dalba.com", name: "Seoyeon" }]);
process.env.ADMIN_EMAILS = "jinwon.choi@dalba.com";


const H = require("../history.js");
const A = require("../auth.js");
const U = require("../unanswered-lib.js");
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const J = "jinwon.choi@dalba.com", L = "luna@dalbausa.com", S = "seoyeon@dalba.com";
const day = d => new Date(Date.now() - d * 86400e3).toISOString();
const rec = (n, first, last, subj) => ({ n, first, last, subj: subj || "", name: "", box: "INBOX" });
(async () => {
  // Luna 메일함
  await H.bookMerge("recv", L, new Map([
    ["waiting@x.com", rec(1, day(5), day(5), "Re: Collab")],       // 툴로 보냄(10일 전) → 5일 전 회신 → 대기
    ["answered@x.com", rec(1, day(6), day(6), "Re: Hi")],          // 웹메일로 2일 전 답함 → 대기 아님
    ["remind@x.com", rec(1, day(4), day(4), "Re: Offer")],         // 회신 뒤 리마인드가 나감 → 대기 아님
    ["stranger@x.com", rec(1, day(3), day(3), "Buy our ads")],     // 연락한 적 없음 → 제외
    ["noreply@brand.com", rec(1, day(3), day(3), "Newsletter")],   // 사람 아님 → 제외
    ["ooo@x.com", rec(1, day(2), day(2), "Automatic reply: Re: Collab")],  // 자동 응답 → 제외
    ["old@x.com", rec(1, day(90), day(90), "Re: Old")],            // 60일 넘음 → 제외
    ["web@x.com", rec(2, day(9), day(1), "Re: Webmail thread")],   // 웹메일로 보냄(3일 전) → 1일 전 회신 → 대기
    ["loggedreply@x.com", rec(1, day(8), day(8), "Re: Hello")]     // 다른 담당자가 보냈고 Luna 메일함에 회신 기록 → 대기
  ]));
  await H.bookMerge("sent", L, new Map([
    ["answered@x.com", rec(2, day(10), day(2))],
    ["web@x.com", rec(1, day(3), day(3))]
  ]));
  lists.set("outreach:log", [
    { to: "waiting@x.com", name: "Wait Er", handle: "waiter", at: day(10), by: L, byName: "Luna" },
    { to: "remind@x.com", at: day(12), by: L, byName: "Luna" },
    { to: "loggedreply@x.com", at: day(9), by: S, byName: "Seoyeon" }
  ].map(x => JSON.stringify(x)));
  lists.set("outreach:reminders:log", [JSON.stringify({ to: "remind@x.com", by: L, at: day(1), n: 1 })]);
  lists.set("outreach:replies", [JSON.stringify({ from: "loggedreply@x.com", inbox: L, by: L, at: day(8), subject: "Re: Hello" })]);

  const rows = await U.unansweredFor(L, await U.loadShared(), {});
  const got = rows.map(r => r.email);
  ck(JSON.stringify(got) === JSON.stringify(["loggedreply@x.com", "waiting@x.com", "web@x.com"]), "unanswered set, oldest first: " + got.join(","));
  const w = rows.find(r => r.email === "waiting@x.com");
  ck(w.waitingDays === 5 && w.name === "Wait Er" && w.handle === "waiter" && w.subject === "Re: Collab", "row details: " + JSON.stringify(w));
  ck(rows.find(r => r.email === "web@x.com").inCount === 2, "incoming count");

  // 담당자 API — 본인 것만
  const pipe = require("../api/pipeline.js");
  const call = (mod, user, query) => new Promise(res => { A.currentUser = () => user; const o = { _s: 0, setHeader() {}, status(x) { this._s = x; return this; }, json(b) { res({ status: this._s, body: b }); } }; mod({ method: "GET", headers: {}, query }, o); });
  let r = await call(pipe, { email: L, name: "Luna" }, { view: "unanswered", staff: S });
  ck(r.status === 200 && r.body.rows.length === 3, "staff sees own list (staff param ignored): " + r.status + " " + (r.body.rows || []).length);
  r = await call(pipe, { email: S, name: "Seoyeon" }, { view: "unanswered" });
  ck(r.body.rows.length === 0, "other staff sees only their own (empty)");

  // 관리자 API
  await H.bookMerge("recv", J, new Map([["adminpeer@x.com", rec(1, day(2), day(2), "Re: SECRET ADMIN")]]));
  await H.bookMerge("sent", J, new Map([["adminpeer@x.com", rec(1, day(4), day(4))]]));
  const admin = require("../api/admin.js");
  r = await call(admin, { email: J, name: "Jinwon" }, { view: "unanswered" });
  const byStaff = Object.fromEntries(r.body.staff.map(s => [s.email, s.rows.length]));
  ck(r.status === 200 && byStaff[L] === 3 && byStaff[J] === 1, "admin sees all staff incl. own: " + JSON.stringify(byStaff));
  r = await call(admin, { email: J, name: "Jinwon" }, { view: "unanswered", staff: L });
  ck(r.body.staff.length === 1 && r.body.staff[0].email === L, "admin staff filter");
  r = await call(admin, { email: L, name: "Luna" }, { view: "unanswered" });
  ck(r.status === 403, "non-admin blocked from admin view");
  console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch(e => { console.log("THREW", e.stack); process.exit(1); });
