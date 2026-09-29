// 테스트: 메일 본문 저장 용량 상한
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



process.env.MSG_STORE_MAX_MB = "1";
const H = require("../history.js");
const M = require("../mail.js");
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
(async () => {
  // partial fetch: body requests only the first 64KB
  global.FAKE = { boxes: [{ path: "INBOX", name: "INBOX" }, { path: "Sent", name: "Sent", specialUse: "\\Sent" }],
    msgs: { INBOX: [{ uid: 1, id: "<1>", date: "2026-06-01T00:00:00Z", subject: "s", from: "x@gmail.com", to: ["me@dalba.com"], body: "hello" }], Sent: [] } };
  global.FETCH_QUERIES = [];
  await M.readFolders({ email: "me@dalba.com", appPassword: "x" }, { since: "2026-05-01", withBody: true, budgetMs: 5000 });
  const q = global.FETCH_QUERIES.find(x => x && x.source);
  ck(q && q.source.start === 0 && q.source.maxLength === 65536, "partial fetch (first 64KB): " + JSON.stringify(q));
  global.FETCH_QUERIES = [];
  await M.readFolders({ email: "me@dalba.com", appPassword: "x" }, { since: "2026-05-01", budgetMs: 5000 });
  ck(global.FETCH_QUERIES.every(x => !x.source), "no body fetched unless asked");

  // cap: 1MB cap already used → records stored without text
  kv.set("outreach:msg:bytes", String(1048576));
  const r = await H.storeMessages("me@dalba.com", [{ id: "<a>", dir: "in", at: "2026-06-01T00:00:00Z", from: "x@gmail.com", subject: "hi", text: "secret body", peers: ["x@gmail.com"] }]);
  ck(r.full && r.stored === 1 && r.noText === 1, "cap reached → stored without body: " + JSON.stringify(r));
  const saved = (await H.messagesWith("me@dalba.com", "x@gmail.com"))[0];
  ck(saved && !saved.text && saved.textDropped === true && saved.subject === "hi", "record kept, body dropped");
  const u = await H.messageUsage();
  ck(u.full && u.capMB === 1, "usage reports full: " + JSON.stringify(u));
  // under the cap → body kept
  kv.set("outreach:msg:bytes", "0");
  await H.storeMessages("me@dalba.com", [{ id: "<b>", dir: "in", at: "2026-06-02T00:00:00Z", from: "y@gmail.com", subject: "yo", text: "kept body", peers: ["y@gmail.com"] }]);
  ck((await H.messagesWith("me@dalba.com", "y@gmail.com"))[0].text === "kept body", "under cap → body kept");
  console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch(e => { console.log("THREW", e.stack || e); process.exit(1); });
