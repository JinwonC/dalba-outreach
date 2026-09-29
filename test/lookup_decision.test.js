// 테스트: 🔎 중복 검사 판정 (회신·최근 발송·재발송 가능·없음·협업)
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




process.env.NW_ACCOUNTS = JSON.stringify([
  { id: "jinwon", pw: "x", appPassword: "y", email: "jinwon.choi@dalba.com", name: "Jinwon" },
  { id: "luna", pw: "x", appPassword: "y", email: "luna@dalbausa.com", name: "Luna" }]);
process.env.ADMIN_EMAILS = "jinwon.choi@dalba.com";

const H = require("../history.js");
const A = require("../auth.js");
const IH = require("../inhouse.js");
IH.loadHandles = async () => ({ at: Date.now(), handles: new Set(["collabgirl"]), emails: new Map(), squashed: new Map(), tabs: [] });
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const J = "jinwon.choi@dalba.com", L = "luna@dalbausa.com";
const day = d => new Date(Date.now() - d * 86400e3).toISOString();
(async () => {
  lists.set("outreach:log", [
    { to: "replied@x.com", at: day(40), by: J, byName: "Jinwon", campaign: "c" },
    { to: "recent@x.com", at: day(5), by: J, byName: "Jinwon", campaign: "c" },
    { to: "old@x.com", handle: "oldhandle", at: day(40), by: L, byName: "Luna", campaign: "c" },
    { to: "inbound@x.com", at: day(40), by: J, byName: "Jinwon", campaign: "c" },
    { to: "collab@x.com", handle: "collabgirl", at: day(40), by: J, byName: "Jinwon", campaign: "c" }].map(x => JSON.stringify(x)));
  lists.set("outreach:replies", [JSON.stringify({ from: "replied@x.com", inbox: J, by: J, at: day(30), subject: "SECRET SUBJECT" }),
                                 JSON.stringify({ from: "onlyreply@x.com", inbox: L, by: L, at: day(2), subject: "Re" })]);
  await H.bookMerge("sent", J, new Map([["webmail@x.com", { n: 1, first: day(3), last: day(3), subj: "", name: "", box: "" }],
                                        ["wmold@x.com", { n: 2, first: day(60), last: day(30), subj: "", name: "", box: "" }]]));
  await H.bookMerge("recv", J, new Map([["inbound@x.com", { n: 1, first: day(20), last: day(20), subj: "SECRET2", name: "", box: "INBOX" }],
                                        ["replied@x.com", { n: 1, first: day(30), last: day(30), subj: "", name: "", box: "INBOX" }]]));
  const lookup = require("../api/lookup.js");
  A.currentUser = () => ({ email: L, name: "Luna" });     // 일반 담당자도 쓴다
  const call = body => new Promise(res => { const o = { _s: 0, setHeader() {}, status(x) { this._s = x; return this; }, json(b) { res({ status: this._s, body: b }); } }; lookup({ method: "POST", headers: {}, query: {}, body }, o); });
  const r = await call({ queries: ["replied@x.com", "recent@x.com", "@oldhandle", "inbound@x.com", "webmail@x.com", "wmold@x.com", "fresh@x.com", "onlyreply@x.com", "@collabgirl", "@brandnew"] });
  ck(r.status === 200 && r.body.reapproveDays === 15, "200 + reapproveDays: " + JSON.stringify(r.body).slice(0, 300));
  const by = Object.fromEntries((r.body.results || []).map(x => [x.query, x]));
  const dec = q => by[q] && by[q].decision;
  ck(dec("replied@x.com") === "replied", "reply log → replied: " + dec("replied@x.com"));
  ck(by["replied@x.com"].replyCount === 1, "reply log + recv book of same inbox counted once: " + by["replied@x.com"].replyCount);
  ck(dec("recent@x.com") === "recent" && by["recent@x.com"].daysSinceSent === 5, "5 days → recent");
  ck(dec("@oldhandle") === "ok" && by["@oldhandle"].daysSinceSent === 40, "handle query, 40 days → ok");
  ck(dec("inbound@x.com") === "replied" && by["inbound@x.com"].replyBy.includes("Jinwon"), "mail only in recv book → replied, by Jinwon");
  ck(dec("webmail@x.com") === "recent", "webmail send 3 days ago → recent: " + dec("webmail@x.com"));
  ck(dec("wmold@x.com") === "ok", "webmail send 30 days ago → ok: " + dec("wmold@x.com"));
  ck(dec("fresh@x.com") === "clean" && !by["fresh@x.com"].found, "never contacted → clean");
  ck(dec("@brandnew") === "clean", "new handle → clean");
  ck(dec("onlyreply@x.com") === "replied" && by["onlyreply@x.com"].found, "reply without send → replied & found");
  ck(dec("@collabgirl") === "inhouse", "in-house → inhouse");
  ck(r.body.decisions.replied === 3 && r.body.decisions.clean === 2 && r.body.decisions.inhouse === 1, "decision counts: " + JSON.stringify(r.body.decisions));
  const txt = JSON.stringify(r.body);
  ck(!/SECRET/.test(txt), "no subjects leak into lookup response");
  ck(!/_emails|"replies"/.test(txt), "internal fields stripped");
  ck(r.body.partial && r.body.partial.mailbox === false && r.body.partial.inhouse === false, "not partial: " + JSON.stringify(r.body.partial));
  // 단건 GET 도 판단을 준다
  const g = await new Promise(res => { const o = { _s: 0, setHeader() {}, status(x) { this._s = x; return this; }, json(b) { res({ status: this._s, body: b }); } }; lookup({ method: "GET", headers: {}, query: { q: "inbound@x.com" } }, o); });
  ck(g.body.results[0].decision === "replied", "GET single decision");
  console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})();
