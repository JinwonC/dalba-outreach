// 테스트: 관리자 메일함의 대화는 본인만 — 다른 관리자·담당자에게 숨김
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



process.env.NW_ACCOUNTS = JSON.stringify([
  { id: "jinwon", pw: "x", appPassword: "y", email: "jinwon.choi@dalba.com", name: "Jinwon" },
  { id: "hannie", pw: "x", appPassword: "y", email: "hannie@dalbausa.com", name: "Hannie" },
  { id: "luna", pw: "x", appPassword: "y", email: "luna@dalbausa.com", name: "Luna" },
  { id: "seoyeon", pw: "x", appPassword: "y", email: "seoyeon@dalba.com", name: "Seoyeon" }]);
process.env.ADMIN_EMAILS = "jinwon.choi@dalba.com, hannie@dalbausa.com";
const A = require("../auth.js");
const H = require("../history.js");
const M = require("../mail.js");
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const J = { email: "jinwon.choi@dalba.com", name: "Jinwon" }, L = { email: "luna@dalbausa.com", name: "Luna" };
(async () => {
  // matrix
  ck(A.canViewMailbox(J, "jinwon.choi@dalba.com") === true, "admin: own mailbox ok");
  ck(A.canViewMailbox(J, "hannie@dalbausa.com") === false, "admin: other admin's mailbox hidden");
  ck(A.canViewMailbox(J, "luna@dalbausa.com") === true, "admin: staff mailbox ok");
  ck(A.canViewMailbox(L, "luna@dalbausa.com") === true, "staff: own ok");
  ck(A.canViewMailbox(L, "jinwon.choi@dalba.com") === false, "staff: admin mailbox hidden");
  ck(A.canViewMailbox(L, "seoyeon@dalba.com") === false, "staff: colleague hidden");

  let threadCalls = 0;
  M.readThread = async () => { threadCalls++; return { rows: [{ subject: "x" }] }; };
  const call = (mod, req, user) => new Promise(res => { A.currentUser = () => user; const r = { _s: 0, setHeader() {}, status(x) { this._s = x; return this; }, json(o) { res({ status: this._s, body: o }); } }; Promise.resolve(mod(Object.assign({ headers: {}, query: {} }, req), r)).catch(e => res({ status: 0, body: { error: String(e) } })); });
  const thread = require("../api/thread.js");
  let r = await call(thread, { method: "GET", query: { staff: "hannie@dalbausa.com", peer: "c@x.com" } }, J);
  ck(r.status === 403 && /관리자 메일함/.test(r.body.error) && threadCalls === 0, "thread: admin → other admin blocked (mailbox not read)");
  r = await call(thread, { method: "GET", query: { staff: "jinwon.choi@dalba.com", peer: "c@x.com" } }, J);
  ck(r.status === 200, "thread: own admin mailbox ok");
  r = await call(thread, { method: "GET", query: { staff: "luna@dalbausa.com", peer: "c@x.com" } }, J);
  ck(r.status === 200, "thread: admin → staff ok");
  r = await call(thread, { method: "GET", query: { staff: "jinwon.choi@dalba.com", peer: "c@x.com" } }, L);
  ck(r.status === 403, "thread: staff → admin blocked");

  const replies = require("../api/replies.js");
  r = await call(replies, { method: "GET", query: { diagnose: "1", user: "hannie@dalbausa.com" } }, J);
  ck(r.status === 403 && /관리자 메일함/.test(r.body.error), "diagnose: other admin blocked");

  // conversations list hides other admin's mailbox, keeps own + staff
  const now = new Date().toISOString();
  lists.set("outreach:log", [
    { to: "a@x.com", by: "hannie@dalbausa.com", byName: "Hannie", at: now },
    { to: "b@x.com", by: "jinwon.choi@dalba.com", byName: "Jinwon", at: now },
    { to: "c@x.com", by: "luna@dalbausa.com", byName: "Luna", at: now }].map(x => JSON.stringify(x)));
  lists.set("outreach:replies", [
    { from: "a@x.com", inbox: "hannie@dalbausa.com", by: "hannie@dalbausa.com", at: now, subject: "re" },
    { from: "b@x.com", inbox: "jinwon.choi@dalba.com", by: "jinwon.choi@dalba.com", at: now, subject: "re" },
    { from: "c@x.com", inbox: "luna@dalbausa.com", by: "luna@dalbausa.com", at: now, subject: "re" }].map(x => JSON.stringify(x)));
  const admin = require("../api/admin.js");
  r = await call(admin, { method: "GET", query: { view: "conversations" } }, J);
  const groups = (r.body.rows || []).map(g => g.by);
  ck(r.status === 200 && !groups.includes("hannie@dalbausa.com") && groups.includes("jinwon.choi@dalba.com") && groups.includes("luna@dalbausa.com"), "대화 tab: other admin hidden, own + staff shown: " + groups.join(","));
  ck(JSON.stringify(r.body.hiddenMailboxes) === JSON.stringify(["hannie@dalbausa.com"]), "hiddenMailboxes = other admins: " + JSON.stringify(r.body.hiddenMailboxes));
  console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch(e => { console.log("THREW", e.stack || e); process.exit(1); });
