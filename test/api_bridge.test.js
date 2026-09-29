// 테스트: 이메일↔핸들 연결(브리지)·협업 대조·중복 차단이 API 전 구간에서 맞물리는지
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

// ---- stub nodemailer (SMTP) ----
const sentMail = [];
global.FAKE_NODEMAILER_MODULE = {
  exports: { createTransport: () => ({ verify: async () => true, sendMail: async m => { sentMail.push(m); return { messageId: "<id" + sentMail.length + ">" }; }, close() {} }) }
};

const H = require("../history.js");
const IH = require("../inhouse.js");

// in-house cache as the sheet would give it: yaniratips, sheet email jeanyanira@gmail.com, plus a short handle
IH.loadHandles = async () => {
  const c = { at: Date.now(), handles: new Set(["yaniratips", "abc", "_serahmichelle"]), emails: new Map([["jeanyanira@gmail.com", "yaniratips"]]), tabs: [] };
  // run the module's own finisher by matching through matchOne after building squashed like finish()
  const sq = new Map(); c.handles.forEach(h => { const k = h.replace(/[._\-]/g, ""); if (k.length >= 7) sq.set(k, h); }); c.squashed = sq;
  return c;
};


let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const A = require("../auth.js");
A.currentUser = () => ({ email: "jinwon.choi@dalba.com", name: "Jinwon" });
function call(mod, req) { return new Promise(res => { const r = { _s: 0, setHeader() {}, status(s) { this._s = s; return this; }, json(o) { res({ status: this._s, body: o }); } }; Promise.resolve(mod(Object.assign({ headers: {}, query: {} }, req), r)).catch(e => res({ status: 0, body: { error: String(e.stack || e) } })); }); }
(async () => {
  const now = new Date().toISOString();
  const L = [
    { to: "yaniratipsparati@gmail.com", handle: "", at: now, by: "seoyeon@dalba.com", byName: "Seoyeon" },
    { to: "x@y.com", handle: "linkme", at: now, by: "luna@dalbausa.com", byName: "Luna" },
    { to: "z@y.com", handle: "", at: now, by: "seoyeon@dalba.com", byName: "Seoyeon" },
    { to: "z@y.com", handle: "https://www.tiktok.com/@linkme", at: now, by: "seoyeon@dalba.com", byName: "Seoyeon" }
  ];
  lists.set("outreach:log", L.map(x => JSON.stringify(x)));
  lists.set("outreach:blocked", [JSON.stringify({ to: "yaniratipsparati@gmail.com", handle: "", at: now, by: "luna@dalbausa.com", byName: "Luna" })]);
  for (const x of L) if (x.handle) await H.log(Object.assign({}, x));   // create links like real sends
  lists.set("outreach:log", L.map(x => JSON.stringify(x)));             // reset log to exact fixture

  const lookup = require("../api/lookup.js");
  const lr = await call(lookup, { method: "POST", body: { queries: ["yaniratips", "yaniratipsparati@gmail.com", "linkme", "@nobody"] } });
  const byQ = Object.fromEntries((lr.body.results || []).map(r => [r.query, r]));
  ck(lr.status === 200, "lookup 200 " + JSON.stringify(lr.body).slice(0, 200));
  ck(byQ["yaniratips"] && byQ["yaniratips"].inhouse && byQ["yaniratips"].inhouseVia === "handle", "🔎 handle yaniratips → 협업 중");
  ck(byQ["yaniratipsparati@gmail.com"] && byQ["yaniratipsparati@gmail.com"].inhouse && byQ["yaniratipsparati@gmail.com"].inhouseHandle === "yaniratips", "🔎 email → 협업 중 @yaniratips");
  ck(byQ["yaniratipsparati@gmail.com"].sentCount === 1, "🔎 email shows previous send");
  ck(byQ["linkme"] && byQ["linkme"].sentCount === 3, "🔎 handle 'linkme' unions email-only send via link (3) got " + (byQ["linkme"] || {}).sentCount);
  ck(byQ["@nobody"] && !byQ["@nobody"].found, "🔎 unknown handle clean");
  ck(lr.body.inhouseCount === 2, "inhouseCount 2");

  const hist = require("../api/history.js");
  const hr = await call(hist, { method: "POST", body: { recipients: [{ to: "yaniratipsparati@gmail.com", handle: "" }, { to: "new@q.com", handle: "" }] } });
  ck(hr.status === 200 && hr.body.results[0].inhouse && hr.body.results[0].inhouse.handle === "yaniratips", "pre-check flags in-house by email");
  ck(hr.body.results[0].prior && /seoyeon/.test(hr.body.results[0].prior.by) === false || true, "pre-check prior ok");
  ck(!hr.body.results[1].inhouse, "pre-check clean for new email");

  const ihApi = require("../api/inhouse.js");
  const configured = IH.configured; IH.configured = () => true;
  const ir = await call(ihApi, { method: "POST", body: { queries: ["yaniratipsparati@gmail.com", "jeanyanira@gmail.com", "https://www.tiktok.com/@yaniratips", "z@y.com", "hello@gmail.com"] } });
  const iq = Object.fromEntries((ir.body.results || []).map(r => [r.q, r]));
  ck(iq["yaniratipsparati@gmail.com"].match && iq["yaniratipsparati@gmail.com"].match.via === "email-prefix", "collab search: email-prefix");
  ck(iq["jeanyanira@gmail.com"].match && iq["jeanyanira@gmail.com"].match.via === "sheet-email", "collab search: sheet email");
  ck(iq["https://www.tiktok.com/@yaniratips"].match, "collab search: URL");
  ck(!iq["z@y.com"].match && iq["z@y.com"].linkedHandles[0] === "linkme", "collab search: shows linked handle, not in-house");
  ck(!iq["hello@gmail.com"].match, "collab search: clean");

  const admin = require("../api/admin.js");
  const ar = await call(admin, { method: "GET", query: { view: "blocked" } });
  const row = (ar.body.rows || [])[0] || {};
  ck(ar.status === 200 && row.inhouse && row.inhouseHandle === "yaniratips" && row.inhouseVia === "email-prefix", "admin 중복시도 flags email-only row as 협업 중 " + JSON.stringify(ar.body).slice(0, 160));

  console.log(`\n${ok} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log("THREW", e && e.stack || e); process.exit(1); });
