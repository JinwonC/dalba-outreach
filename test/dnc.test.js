// 테스트: 🚫 수신 거부 — 등록(연결된 이메일·핸들까지), 본인 발송 이력·관리자 강제도 막음, 해제는 관리자만
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
const IH = require("../inhouse.js");
IH.loadHandles = async () => ({ at: Date.now(), handles: new Set(), emails: new Map(), squashed: new Map(), tabs: [] });
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const J = "jinwon.choi@dalba.com", L = "luna@dalbausa.com";
const day = d => new Date(Date.now() - d * 86400e3).toISOString();
const call = (mod, user, req) => new Promise(res => { A.currentUser = () => user; const o = { _s: 0, setHeader() {}, status(x) { this._s = x; return this; }, json(b) { res({ status: this._s, body: b }); } }; mod(Object.assign({ headers: {}, query: {} }, req), o); });
(async () => {
  // Luna 가 예전에 보낸 크리에이터 (이메일+핸들 연결됨)
  await H.log({ to: "creator@gmail.com", handle: "creatorh", at: day(10), by: L, byName: "Luna" });
  await H.log({ to: "creator.alt@gmail.com", handle: "creatorh", at: day(9), by: L, byName: "Luna" });
  const lookup = require("../api/lookup.js");
  let r = await call(lookup, { email: L, name: "Luna" }, { method: "POST", body: { action: "dnc", items: ["creator@gmail.com"], reason: "asked to stop" } });
  ck(r.status === 200 && r.body.ok && r.body.targets === 1, "staff can register do-not-contact: " + JSON.stringify(r.body));
  let sup = await H.suppressCheck([{ to: "creator@gmail.com" }, { handle: "creatorh" }, { to: "creator.alt@gmail.com" }]);
  ck(sup.every(x => x && x.type === "dnc" && x.addedBy === L && x.reason === "asked to stop"), "email + linked handle + other linked email all blocked: " + JSON.stringify(sup.map(x => x && x.field)));
  // 본인이 예전에 보냈어도(본인 발송 이력) 수신 거부는 막는다
  const SC = require("../send-core.js");
  const camp = { subject: "Hi", pitch: "p", brand: "d'Alba", campaignTitle: "T" };
  let out = await SC.sendBatch({ account: { email: L, name: "Luna", password: "x" }, campaign: camp, recipients: [{ to: "creator@gmail.com", creatorName: "C" }], admin: false });
  ck(out.results[0].ok === false && out.results[0].suppressed === "dnc" && /수신 거부/.test(out.results[0].error), "own prior send does not override do-not-contact");
  out = await SC.sendBatch({ account: { email: J, name: "Jinwon", password: "x" }, campaign: camp, recipients: [{ to: "new@gmail.com", creatorName: "N", handle: "creatorh" }], admin: true, force: true });
  ck(out.results[0].ok === false && out.results[0].suppressed === "dnc", "new email with the same handle is blocked, even admin force");
  // 핸들로 등록
  r = await call(lookup, { email: L, name: "Luna" }, { method: "POST", body: { action: "dnc", items: ["https://www.tiktok.com/@stopper"] } });
  [sup] = await H.suppressCheck([{ handle: "stopper" }]);
  ck(sup && sup.type === "dnc", "handle URL registered as handle");
  r = await call(lookup, { email: L, name: "Luna" }, { method: "POST", body: { action: "dnc", items: [] } });
  ck(r.status === 400, "empty → 400");
  // 해제는 관리자만
  const admin = require("../api/admin.js");
  r = await call(admin, { email: L, name: "Luna" }, { method: "POST", body: { action: "unsuppress", fields: ["e:creator@gmail.com"] } });
  ck(r.status === 403, "staff cannot remove");
  r = await call(admin, { email: J, name: "Jinwon" }, { method: "POST", body: { action: "dnc", items: ["adm@x.com"], reason: "admin added" } });
  [sup] = await H.suppressCheck([{ to: "adm@x.com" }]);
  ck(r.status === 200 && sup && sup.addedBy === J, "admin can register from admin page");
  // 🔎 중복 검사에 표시
  r = await call(lookup, { email: L, name: "Luna" }, { method: "POST", body: { queries: ["@creatorh"] } });
  ck(r.body.results[0].suppressed && r.body.results[0].suppressed.type === "dnc", "🔎 shows do-not-contact for the handle");
  console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch(e => { console.log("THREW", e.stack); process.exit(1); });
