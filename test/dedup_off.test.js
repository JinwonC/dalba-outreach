// 테스트: 담당자끼리 중복 차단 꺼짐(기본) — 다른 담당자 크리에이터도 발송, 협업 중·수신 거부·30분 재발송 방지는 유지
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
IH.loadHandles = async () => ({ at: Date.now(), handles: new Set(["collabby"]), emails: new Map(), squashed: new Map(), tabs: [] });
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const J = "jinwon.choi@dalba.com", L = "luna@dalbausa.com", S = "seoyeon@dalba.com";
const day = d => new Date(Date.now() - d * 86400e3).toISOString();
const SC = require("../send-core.js");
const camp = { pitch: "p", campaignTitle: "T", brand: "d'Alba" };
const send = (by, name, recips, admin) => SC.sendBatch({ account: { email: by, name, password: "x" }, campaign: camp, recipients: recips, admin: Boolean(admin) });
(async () => {
  delete process.env.DEDUP_ACROSS_STAFF;
  ck(H.dedupAcrossStaff() === false, "cross-staff dedup is off by default");
  // 서연이 툴로 보낸 크리에이터 (이메일+핸들), 진원이 웹메일 단체로 보낸 주소
  await H.log({ to: "shared@gmail.com", handle: "sharedh", at: day(3), by: S, byName: "Seoyeon" });
  await H.reserve({ to: "shared@gmail.com", handle: "sharedh" }, { by: S }, false);
  await H.bookMerge("sent", J, new Map([["group@gmail.com", { n: 1, first: day(2), last: day(2), subj: "", name: "", box: "" }]]));
  const blockedBefore = (lists.get("outreach:blocked") || []).length;
  let out = await send(L, "Luna", [{ to: "shared@gmail.com", creatorName: "Sh" }, { to: "other@gmail.com", creatorName: "O", handle: "sharedh" }, { to: "group@gmail.com", creatorName: "G" }]);
  ck(out.results.every(r => r.ok), "other staff's creator (email, same handle, webmail group) all go out: " + JSON.stringify(out.results.map(r => [r.to, r.ok, r.error])));
  ck((lists.get("outreach:blocked") || []).length === blockedBefore, "no 중복 시도 records logged");
  // 🤝 협업 중은 여전히 막힌다 (보낸 적 없는 담당자) — 관리자는 통과
  out = await send(L, "Luna", [{ to: "collab@gmail.com", creatorName: "C", handle: "collabby" }]);
  ck(out.results[0].ok === false && out.results[0].inhouse, "in-house creator still held for staff");
  out = await send(J, "Jinwon", [{ to: "collab@gmail.com", creatorName: "C", handle: "collabby" }], true);
  ck(out.results[0].ok === true, "admin can still send to in-house");
  // 🚫 수신 거부·⛔ 반송은 여전히 막힌다
  await H.suppressAdd([{ email: "stop@gmail.com", type: "dnc", reason: "asked" }]);
  out = await send(L, "Luna", [{ to: "stop@gmail.com", creatorName: "S" }]);
  ck(out.results[0].ok === false && out.results[0].suppressed === "dnc", "do-not-contact still held");
  // 같은 담당자의 30분 안 재발송 방지는 그대로
  await new Promise(r => setTimeout(r, 50));
  out = await send(L, "Luna", [{ to: "shared@gmail.com", creatorName: "Sh" }]);
  ck(out.results[0].ok === false && out.results[0].recent, "same staff re-send within 30 min still skipped");
  // 사전 확인은 이전 발송을 그대로 알려 준다 (화면은 '참고'로만 표시)
  const hist = require("../api/history.js");
  A.currentUser = () => ({ email: S, name: "Seoyeon" });
  const hr = await new Promise(r => { const o = { _s: 0, setHeader() {}, status(x) { this._s = x; return this; }, json(b) { r({ status: this._s, body: b }); } }; hist({ method: "POST", headers: {}, query: {}, body: { recipients: [{ to: "group@gmail.com" }] } }, o); });
  ck(hr.body.results[0].prior && hr.body.results[0].prior.by !== S, "pre-check still reports who sent before (for info): " + JSON.stringify(hr.body.results[0].prior));
  // 설정 응답
  const api = require("../api/outreach-send.js");
  const g = await new Promise(r => { const o = { _s: 0, setHeader() {}, status(x) { this._s = x; return this; }, json(b) { r({ status: this._s, body: b }); } }; api({ method: "GET", headers: {}, query: {} }, o); });
  ck(g.body.dedupAcrossStaff === false, "config tells the screen dedup is off");
  console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch(e => { console.log("THREW", e.stack); process.exit(1); });
