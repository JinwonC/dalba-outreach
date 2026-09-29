// 테스트: 크론 동기화 한 바퀴가 여러 실행에 걸쳐도 끝으로 인정되는지 (1시간 간격 유지)
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




process.env.NW_ACCOUNTS = JSON.stringify(["a","b","c","d","e"].map(x => ({ id: x, pw: "x", appPassword: "y", email: x + "@dalba.com", name: x })));
process.env.ADMIN_EMAILS = "a@dalba.com";
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const realNow = Date.now; let off = 0; Date.now = () => realNow() + off;
const S = require("../sync.js");
const Sch = require("../scheduled.js"); const R = require("../reminders.js");
const H = require("../history.js");
Sch.processDue = async () => ({}); R.sendDue = async () => ({});
H.bridgeReady = async () => true;
const synced = [];
S.contactedMap = async () => new Map();
S.syncAccount = async (acc) => { synced.push(acc.email[0]); off += 20e3; return { user: acc.email }; };   // 계정 하나에 20초
const cron = require("../api/cron.js");
const run = () => new Promise(res => { const o = { _s: 0, setHeader() {}, status(x) { this._s = x; return this; }, json(b) { res({ status: this._s, body: b }); } }; cron({ method: "GET", headers: { "x-vercel-cron": "1" }, query: {} }, o); });
(async () => {
  let r = await run();
  ck(synced.join("") === "abc" && r.body.complete === false, "run 1: a,b,c then out of budget: " + synced.join(""));
  ck(!kv.get("outreach:cron:syncAt"), "round not finished → no syncAt yet");
  off += 15 * 60e3; synced.length = 0;
  r = await run();
  ck(synced.join("") === "de" && r.body.complete === true, "run 2 continues d,e and finishes the round: " + synced.join(""));
  ck(Boolean(kv.get("outreach:cron:syncAt")), "round finished across runs → syncAt written");
  off += 15 * 60e3; synced.length = 0;
  r = await run();
  ck(synced.length === 0 && r.body.syncSkipped === true, "run 3 (15 min later) skips the heavy sync");
  off += 45 * 60e3; synced.length = 0;
  r = await run();
  ck(synced.join("") === "abc", "an hour after the round, a new round starts from the top: " + synced.join(""));
  console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch(e => { console.log("THREW", e.stack); process.exit(1); });
