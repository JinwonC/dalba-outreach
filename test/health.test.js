// 테스트: 🩺 시스템 상태 — 크론 멈춤·동기화 실패·오래된 메일함·저장 공간·저장소 오류 문구
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
const HL = require("../health-lib.js");
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const J = "jinwon.choi@dalba.com", L = "luna@dalbausa.com", S = "seoyeon@dalba.com";
const now = Date.now(), ago = m => new Date(now - m * 60e3).toISOString();
const call = (mod, user, req) => new Promise(res => { A.currentUser = () => user; const o = { _s: 0, setHeader() {}, status(x) { this._s = x; return this; }, json(b) { res({ status: this._s, body: b }); } }; mod(Object.assign({ headers: {}, query: {} }, req), o); });
(async () => {
  const staff = [{ email: J, name: "Jinwon" }, { email: L, name: "Luna" }, { email: S, name: "Seoyeon" }];
  // 모두 정상
  let r = HL.evaluate({ now, cron: { at: ago(10) }, syncAt: ago(30), staff, info: new Map(staff.map(x => [x.email, { at: ago(40) }])) });
  ck(r.ok && r.items.length === 0, "all healthy: " + JSON.stringify(r.items));
  // 크론 멈춤 + 동기화 실패 + 오래된 메일함 + 저장 공간
  r = HL.evaluate({ now, cron: { at: ago(120), reminders: { error: "boom" } }, syncAt: ago(300), staff, info: new Map([
    [J, { at: ago(20), error: "Command failed: AUTHENTICATIONFAILED Invalid credentials" }],
    [L, { at: ago(8 * 60), msgsFull: true }]
  ]) });
  const codes = r.items.map(i => i.code);
  ck(!r.ok && codes[0] === "cron-stale" && codes.includes("sync-error") && codes.includes("mailbox-stale") && codes.includes("msgs-full") && codes.includes("never-synced") && codes.includes("reminders-error") && codes.includes("round-stale"), "problems found: " + codes.join(","));
  const se = r.items.find(i => i.code === "sync-error");
  ck(se.name === "Jinwon" && se.msg === "메일함 동기화 실패" && /앱 비밀번호/.test(se.hint) && /AUTHENTICATIONFAILED/.test(se.detail), "sync error carries name, message, hint: " + JSON.stringify(se));
  ck(r.items.findIndex(i => i.level === "info") > r.items.findIndex(i => i.level === "warn"), "sorted error → warn → info");
  ck(/2시간/.test(r.items.find(i => i.code === "cron-stale").msg), "readable duration");
  r = HL.evaluate({ now, cron: null, staff: [], info: new Map() });
  ck(r.items[0].code === "cron-missing", "cron never ran");
  ck(/Upstash 요청 한도 초과/.test(H.storageHint("ERR max requests limit exceeded. Limit: 500000")), "storage limit hint");

  // 관리자 API
  kv.set("outreach:cron:status", JSON.stringify({ at: ago(5) }));
  kv.set("outreach:cron:syncAt", ago(20));
  await H.saveSyncInfo(J, { sentFolder: "Sent" });
  await H.saveSyncInfo(L, { error: "AUTHENTICATIONFAILED" });
  const admin = require("../api/admin.js");
  let ar = await call(admin, { email: J, name: "Jinwon" }, { method: "GET", query: { view: "health" } });
  ck(ar.status === 200 && ar.body.ok === false && ar.body.items.some(i => i.code === "sync-error" && i.staff === L) && ar.body.items.some(i => i.code === "never-synced" && i.staff === S), "admin health: " + JSON.stringify(ar.body.items && ar.body.items.map(i => i.code)));
  ar = await call(admin, { email: L, name: "Luna" }, { method: "GET", query: { view: "health" } });
  ck(ar.status === 403, "staff can't read admin health");
  // 담당자 본인 알림
  const pipe = require("../api/pipeline.js");
  const pr = await call(pipe, { email: L, name: "Luna" }, { method: "GET", query: { view: "unanswered" } });
  ck(pr.body.syncError === "AUTHENTICATIONFAILED" && /앱 비밀번호/.test(pr.body.syncHint), "staff gets own sync error + hint");
  // 저장소 오류 문구
  const realFetch = global.fetch;
  global.fetch = async () => ({ json: async () => ({ error: "ERR max requests limit exceeded. Limit: 500000, Usage: 500000" }) });
  let msg = "";
  try { await H.readRaw("x"); } catch (e) { msg = e.message; }
  global.fetch = realFetch;
  ck(/이력 저장소 오류: ERR max requests limit exceeded/.test(msg) && /Pay as You Go/.test(msg), "storage error explains what to do: " + msg);
  console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch(e => { console.log("THREW", e.stack); process.exit(1); });
