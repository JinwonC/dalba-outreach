// 테스트: 발송 시간 예산(leftover 로 이어 보내기) · 30분 안 같은 담당자 재발송 방지 · 묶음 사전 조회
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
  { id: "luna", pw: "x", appPassword: "y", email: "luna@dalbausa.com", name: "Luna" },
  { id: "seoyeon", pw: "x", appPassword: "y", email: "seoyeon@dalba.com", name: "Seoyeon" }]);
process.env.ADMIN_EMAILS = "jinwon.choi@dalba.com";


const H = require("../history.js");
const A = require("../auth.js");
const IH = require("../inhouse.js");
IH.loadHandles = async () => ({ at: Date.now(), handles: new Set(), emails: new Map(), squashed: new Map(), tabs: [] });
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const J = "jinwon.choi@dalba.com", L = "luna@dalbausa.com";
const sent = [];
global.FAKE_NODEMAILER_MODULE = { exports: { createTransport: () => ({ verify: async () => true, close() {}, sendMail: async m => { sent.push(m.to); await new Promise(r => setTimeout(r, Number(global.SMTP_MS || 0))); return { messageId: "<x>" }; } }) } };
const SC = require("../send-core.js");
const camp = { pitch: "p", campaignTitle: "T", brand: "d'Alba" };
const R = n => Array.from({ length: n }, (_, i) => ({ to: "b" + i + "@gmail.com", creatorName: "C" + i }));
(async () => {
  // ── 시간 예산: 다 못 보내면 leftover 로 돌려준다 (아무것도 안 보낸 채로) ──
  global.SMTP_MS = 300;
  let out = await SC.sendBatch({ account: { email: L, name: "Luna", password: "x" }, campaign: camp, recipients: R(6), admin: false, budgetMs: 2500 });
  const okN = out.results.filter(r => r.ok).length;
  ck(okN >= 1 && okN < 6 && out.leftover.length === 6 - okN, "budget stops early with leftover: sent " + okN + ", left " + out.leftover.length);
  ck(out.leftover.every(r => !sent.includes(r.to)), "leftover recipients were not sent");
  global.SMTP_MS = 0;

  // ── 방금 보냄: 같은 담당자가 30분 안에 다시 보내면 건너뜀 ──
  await new Promise(r => setTimeout(r, 50));
  const first = out.results.find(r => r.ok).to;
  const before = sent.length;
  out = await SC.sendBatch({ account: { email: L, name: "Luna", password: "x" }, campaign: camp, recipients: [{ to: first, creatorName: "Again" }], admin: false });
  ck(out.results[0].ok === false && out.results[0].recent === true && /이미 보냈습니다/.test(out.results[0].error) && sent.length === before, "re-send within 30 min skipped: " + JSON.stringify(out.results[0]));
  // 다른 담당자에게는 상관없음 (중복 차단은 기존대로) · 관리자 강제 발송은 통과
  out = await SC.sendBatch({ account: { email: J, name: "Jinwon", password: "x" }, campaign: camp, recipients: [{ to: first, creatorName: "Force" }], admin: true, force: true });
  ck(out.results[0].ok === true, "admin force send not blocked by recent guard");
  // 30분 지난 표시는 무시
  kv.set("outreach:recent:" + L + ":old1@gmail.com", new Date(Date.now() - 40 * 60e3).toISOString());
  out = await SC.sendBatch({ account: { email: L, name: "Luna", password: "x" }, campaign: camp, recipients: [{ to: "old1@gmail.com", creatorName: "O" }], admin: false });
  ck(out.results[0].ok === true, "marker older than 30 min ignored");

  // ── 사전 조회 한 번 + 본인 재발송·다른 담당자 차단은 그대로 ──
  await H.log({ to: "mine@gmail.com", at: new Date(Date.now() - 5 * 86400e3).toISOString(), by: L, byName: "Luna" });
  await H.reserve({ to: "mine@gmail.com" }, { by: J }, true);        // 관리자가 자리를 잡아 둠
  await H.log({ to: "theirs@gmail.com", at: new Date(Date.now() - 5 * 86400e3).toISOString(), by: J, byName: "Jinwon" });
  await H.reserve({ to: "theirs@gmail.com" }, { by: J }, false);
  kv.set("outreach:own:ready", "1");
  out = await SC.sendBatch({ account: { email: L, name: "Luna", password: "x" }, campaign: camp, recipients: [{ to: "mine@gmail.com", creatorName: "M" }, { to: "theirs@gmail.com", creatorName: "T" }], admin: false });
  ck(out.results[0].ok === true, "own creator still goes out (batch precheck)");
  ck(out.results[1].ok === true, "other staff's creator goes out (cross-staff dedup off by default)");

  // ── API: 예산 전달 + leftover 응답 ──
  process.env.SEND_BUDGET_MS = "10000";
  delete require.cache[require.resolve("../api/outreach-send.js")];
  const api = require("../api/outreach-send.js");
  A.currentUser = () => ({ email: L, name: "Luna" });
  global.SMTP_MS = 2500;
  const res = await new Promise(r => { const o = { _s: 0, setHeader() {}, status(x) { this._s = x; return this; }, json(b) { r({ status: this._s, body: b }); } }; api({ method: "POST", headers: {}, query: {}, body: { campaign: camp, recipients: R(8).map((x, i) => Object.assign(x, { to: "api" + i + "@gmail.com" })) } }, o); });
  global.SMTP_MS = 0;
  ck(res.status === 200 && Array.isArray(res.body.leftover) && res.body.leftover.length > 0 && res.body.totals.leftover === res.body.leftover.length && res.body.totals.failed === 0,
     "API returns leftover within budget: " + JSON.stringify(res.body.totals));
  console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch(e => { console.log("THREW", e.stack); process.exit(1); });
