// 테스트: 관리자 ⏸ 중복시도 판정 색 (🔴 회신 · 🟠 15일 내 · 🔵 15일 지남 · 🤝 협업)
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
  { id: "luna", pw: "x", appPassword: "y", email: "luna@dalbausa.com", name: "Luna" }]);
process.env.ADMIN_EMAILS = "jinwon.choi@dalba.com";
const H = require("../history.js");
const A = require("../auth.js");
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const J = "jinwon.choi@dalba.com", L = "luna@dalbausa.com";
const day = d => new Date(Date.now() - d * 86400e3).toISOString();
(async () => {
  lists.set("outreach:log", [
    { to: "replied@x.com", at: day(40), by: J, byName: "Jinwon", campaign: "c" },
    { to: "recent@x.com", at: day(5), by: J, byName: "Jinwon", campaign: "c" },
    { to: "old@x.com", at: day(40), by: J, byName: "Jinwon", campaign: "c" },
    { to: "inbound@x.com", at: day(40), by: J, byName: "Jinwon", campaign: "c" }].map(x => JSON.stringify(x)));
  lists.set("outreach:replies", [JSON.stringify({ from: "replied@x.com", inbox: J, by: J, at: day(30), subject: "Re" })]);
  const b = (to, prior) => JSON.stringify({ to, by: L, byName: "Luna", at: day(1), prior });
  lists.set("outreach:blocked", [
    b("replied@x.com"), b("recent@x.com"), b("old@x.com"),
    b("webmail@x.com", { by: J, at: day(3), source: "mailbox" }), b("wmold@x.com", { by: J, at: day(30), source: "mailbox" }),
    b("inbound@x.com")]);
  await H.bookMerge("sent", J, new Map([["webmail@x.com", { n: 1, first: day(3), last: day(3), subj: "", name: "", box: "" }],
                                        ["wmold@x.com", { n: 2, first: day(60), last: day(30), subj: "", name: "", box: "" }]]));
  await H.bookMerge("recv", J, new Map([["inbound@x.com", { n: 1, first: day(20), last: day(20), subj: "", name: "", box: "INBOX" }]]));

  const admin = require("../api/admin.js");
  A.currentUser = () => ({ email: J, name: "Jinwon" });
  const r = await new Promise(res => { const o = { _s: 0, setHeader() {}, status(x) { this._s = x; return this; }, json(b) { res({ status: this._s, body: b }); } }; admin({ method: "GET", headers: {}, query: { view: "blocked" } }, o); });
  ck(r.status === 200 && r.body.reapproveDays === 15, "200 + reapproveDays 15");
  const by = Object.fromEntries(r.body.rows.map(x => [x.to, x]));
  ck(by["replied@x.com"].decision === "replied", "reply in log → 🔴 replied");
  ck(by["inbound@x.com"].decision === "replied" && by["inbound@x.com"].replies.some(q => q.mailbox), "mail from creator only in mailbox → 🔴 replied");
  ck(by["recent@x.com"].decision === "recent" && by["recent@x.com"].daysSinceSent === 5, "tool send 5 days ago → 🟠 recent");
  ck(by["old@x.com"].decision === "ok" && by["old@x.com"].daysSinceSent === 40, "tool send 40 days ago → 🔵 ok");
  ck(by["webmail@x.com"].decision === "recent" && by["webmail@x.com"].origins.some(o => o.mailbox && o.by === J), "webmail send 3 days ago → 🟠 recent, origin shown as 메일함");
  ck(by["wmold@x.com"].decision === "ok" && by["wmold@x.com"].daysSinceSent === 30, "webmail send 30 days ago → 🔵 ok");
  ck(r.body.timing && typeof r.body.timing.totalMs === "number", "timing reported");

  // ── creator handle on each row ──
  lists.set("outreach:log", [JSON.stringify({ to: "withh@x.com", handle: "https://www.tiktok.com/@creator_one", at: day(40), by: J, byName: "Jinwon" })]);
  await H.log({ to: "linked@x.com", handle: "@linkedcreator", at: day(50), by: J, byName: "Jinwon" });   // stored link
  lists.set("outreach:log", [JSON.stringify({ to: "withh@x.com", handle: "https://www.tiktok.com/@creator_one", at: day(40), by: J, byName: "Jinwon" }),
                             JSON.stringify({ to: "linked@x.com", at: day(50), by: J, byName: "Jinwon" })]);   // log copy without handle
  lists.set("outreach:blocked", [
    JSON.stringify({ to: "typed@x.com", handle: "@TypedHandle", by: L, at: day(1) }),
    JSON.stringify({ to: "withh@x.com", by: L, at: day(1) }),
    JSON.stringify({ to: "linked@x.com", by: L, at: day(1) }),
    JSON.stringify({ to: "nohandle@x.com", by: L, at: day(1) })]);
  const rh = await new Promise(res => { const o = { _s: 0, setHeader() {}, status(x) { this._s = x; return this; }, json(b) { res({ status: this._s, body: b }); } }; admin({ method: "GET", headers: {}, query: { view: "blocked" } }, o); });
  const hb = Object.fromEntries(rh.body.rows.map(x => [x.to, x]));
  ck(hb["typed@x.com"].handle === "typedhandle" && !hb["typed@x.com"].handleLinked, "typed handle shown (normalized)");
  ck(hb["withh@x.com"].handle === "creator_one" && hb["withh@x.com"].handleLinked, "handle filled from send log (URL → handle)");
  ck(hb["linked@x.com"].handle === "linkedcreator" && hb["linked@x.com"].handleLinked, "handle filled from stored email↔handle link");
  ck(hb["nohandle@x.com"].handle === "", "no known handle → empty");
  // 🤝 collab creator → its own group (overrides other decisions)
  const IH0 = require("../inhouse.js");
  const realM = IH0.matcher;
  IH0.matcher = async () => (r, linked) => (r && /typed@x\.com/.test(r.to || "")) ? { handle: "typedhandle", via: "handle" } : null;
  const ri = await new Promise(res => { const o = { _s: 0, setHeader() {}, status(x) { this._s = x; return this; }, json(b) { res({ status: this._s, body: b }); } }; admin({ method: "GET", headers: {}, query: { view: "blocked" } }, o); });
  const ib = Object.fromEntries(ri.body.rows.map(x => [x.to, x]));
  ck(ib["typed@x.com"].decision === "inhouse" && ib["withh@x.com"].decision !== "inhouse", "collab creator → decision 'inhouse'");
  IH0.matcher = realM;

  // ── repeated attempts collapse; long history capped ──
  const many = [];
  for (let i = 0; i < 3; i++) many.push(JSON.stringify({ to: "rep@x.com", by: L, byName: "Luna", at: day(1 + i) }));
  lists.set("outreach:blocked", many);
  const logs = [];
  for (let i = 0; i < 30; i++) logs.push(JSON.stringify({ to: "rep@x.com", at: day(100 + i), by: J, byName: "Jinwon", campaign: "c" + i }));
  lists.set("outreach:log", logs);
  const call = q => new Promise(res => { const o = { _s: 0, setHeader() {}, status(x) { this._s = x; return this; }, json(b) { res({ status: this._s, body: b }); } }; admin({ method: "GET", headers: {}, query: q }, o); });
  let r2 = await call({ view: "blocked" });
  ck(r2.body.rows.length === 1 && r2.body.rows[0].attempts === 3, "3 attempts by same staffer → 1 row, attempts=3");
  ck(r2.body.rows[0].origins.length === 5 && r2.body.rows[0].originsTotal === 30, "origins capped at 5 (total 30)");
  ck(!("prior" in r2.body.rows[0]), "prior dropped when origins exist (smaller payload)");

  // ── slow lookups don't sink the response ──
  const IH = require("../inhouse.js");
  const realMatcher = IH.matcher, realGet = H.bookGetMany;
  IH.matcher = () => new Promise(res => setTimeout(() => res(() => null), 30000));
  H.bookGetMany = () => new Promise(res => setTimeout(() => res(new Map()), 30000));
  const t1 = Date.now();
  r2 = await call({ view: "blocked" });
  const el = Date.now() - t1;
  ck(r2.status === 200 && el < 14000, "slow sheet + slow mailbox lookup → still answers (" + el + "ms)");
  ck(r2.body.partial && r2.body.partial.mailbox === true && r2.body.partial.inhouse === true, "partial flags set: " + JSON.stringify(r2.body.partial));
  ck(r2.body.rows.length === 1 && r2.body.rows[0].decision, "rows still decided from tool records");
  IH.matcher = realMatcher; H.bookGetMany = realGet;

  console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch(e => { console.log("THREW", e.stack || e); process.exit(1); });
