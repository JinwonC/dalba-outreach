// 테스트: 본인이 이전에 보낸 크리에이터는 막히지 않는지 (다른 담당자 기록·협업 중이어도)
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
IH.loadHandles = async () => ({ at: Date.now(), handles: new Set(["collabcreator"]), emails: new Map(), squashed: new Map(), tabs: [] });
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const J = "jinwon.choi@dalba.com", L = "luna@dalbausa.com", S = "seoyeon@dalba.com";
const day = d => new Date(Date.now() - d * 86400e3).toISOString();
(async () => {
  // Luna 가 먼저 보냄(툴), 나중에 Seoyeon 도 보냄 → 차단 키 주인은 Seoyeon
  await H.log({ to: "shared@x.com", handle: "sharedh", at: day(30), by: L, byName: "Luna" });
  await H.reserve({ to: "shared@x.com", handle: "sharedh" }, { by: S, byName: "Seoyeon" }, true);   // force → Seoyeon 이 키 주인
  await H.log({ to: "shared@x.com", handle: "sharedh", at: day(3), by: S, byName: "Seoyeon" });
  let rv = await H.reserve({ to: "shared@x.com", handle: "sharedh" }, { by: L, byName: "Luna" }, false);
  ck(rv.ok === true && rv.own, "Luna sent before, key owned by Seoyeon → Luna allowed: " + JSON.stringify(rv));
  const keyRec = JSON.parse(kv.get("outreach:sent:e:shared@x.com") || "{}");
  ck(keyRec.by === S, "other staffer's key not overwritten: " + keyRec.by);
  rv = await H.reserve({ to: "shared@x.com" }, { by: J, byName: "Jinwon" }, false);
  ck(rv.ok === false, "someone who never sent is still blocked");

  // Luna 는 네이버웍스 웹메일로만 보냄(주소록), Seoyeon 은 툴로 보냄
  await H.bookMerge("sent", L, new Map([["web@x.com", { n: 1, first: day(200), last: day(200), subj: "", name: "", box: "" }]]));
  await H.reserve({ to: "web@x.com" }, { by: S, byName: "Seoyeon" }, false);
  await H.log({ to: "web@x.com", at: day(1), by: S, byName: "Seoyeon" });
  rv = await H.reserve({ to: "web@x.com" }, { by: L, byName: "Luna" }, false);
  ck(rv.ok === true, "Luna's own webmail send (mailbox book) → allowed");

  // 아주 오래전(차단 기간 밖) 본인 발송도 인정
  await H.bookMerge("sent", L, new Map([["ancient@x.com", { n: 1, first: day(500), last: day(500), subj: "", name: "", box: "" }]]));
  await H.reserve({ to: "ancient@x.com" }, { by: S }, false);
  rv = await H.reserve({ to: "ancient@x.com" }, { by: L }, false);
  ck(rv.ok === true, "own send 500 days ago still counts");

  // 핸들로: Luna 가 @handleonly 로 a@x 에 보냄 → 지금 새 이메일 b@x + 같은 핸들
  await H.log({ to: "a1@x.com", handle: "handleonly", at: day(10), by: L, byName: "Luna" });
  await H.reserve({ to: "b1@x.com", handle: "handleonly" }, { by: S }, true);
  rv = await H.reserve({ to: "b1@x.com", handle: "handleonly" }, { by: L }, false);
  ck(rv.ok === true, "own send via same handle, different email → allowed");
  // 연결로: Luna 가 a2@x(핸들 lnk)에 보냄, 지금 b2@x 에 핸들 없이 — b2 는 Seoyeon 발송으로 lnk 와 연결돼 있음
  await H.log({ to: "a2@x.com", handle: "lnk", at: day(10), by: L });
  await H.log({ to: "b2@x.com", handle: "lnk", at: day(2), by: S });
  await H.reserve({ to: "b2@x.com", handle: "lnk" }, { by: S }, true);
  rv = await H.reserve({ to: "b2@x.com" }, { by: L }, false);
  ck(rv.ok === true, "own send via linked handle → allowed");

  // 사전 확인(lookup): 본인 기록을 돌려준다 → 보류 아님
  const [p1] = await H.lookup([{ to: "shared@x.com" }], L);
  ck(p1 && p1.by === L && p1.own, "pre-check returns own record for Luna: " + JSON.stringify(p1));
  const [p2] = await H.lookup([{ to: "shared@x.com" }], J);
  ck(p2 && p2.by !== J && !p2.own, "pre-check for others still shows the other staffer");

  // api/history: held 수에서 본인 건 제외
  const hist = require("../api/history.js");
  const call = (mod, req) => new Promise(res => { const o = { _s: 0, setHeader() {}, status(x) { this._s = x; return this; }, json(b) { res({ status: this._s, body: b }); } }; mod(Object.assign({ headers: {}, query: {} }, req), o); });
  A.currentUser = () => ({ email: L, name: "Luna" });
  const hr = await call(hist, { method: "POST", body: { recipients: [{ to: "shared@x.com" }, { to: "fresh@x.com" }] } });
  ck(hr.body.held === 0, "pre-check held 0 for own creators: " + hr.body.held);

  // 협업 중(인하우스): Luna 가 예전에 보낸 협업 크리에이터 → Luna 는 보낼 수 있음, Mia(안 보낸 사람)는 막힘
  await H.log({ to: "collab@x.com", handle: "collabcreator", at: day(60), by: L });
  const SC = require("../send-core.js");
  const camp = { subject: "Hi", pitch: "p", brand: "d'Alba", campaignTitle: "T" };
  let out = await SC.sendBatch({ account: { email: L, name: "Luna", password: "x" }, campaign: camp, recipients: [{ to: "collab@x.com", creatorName: "C", handle: "collabcreator" }], admin: false });
  ck(out.results[0].ok === true, "Luna → in-house creator she emailed before: sent " + JSON.stringify(out.results[0]));
  out = await SC.sendBatch({ account: { email: S, name: "Seoyeon", password: "x" }, campaign: camp, recipients: [{ to: "collab@x.com", creatorName: "C", handle: "collabcreator" }], admin: false });
  ck(out.results[0].ok === false && out.results[0].inhouse, "Seoyeon (never sent) → in-house still held");
  const hr2 = await call(hist, { method: "POST", body: { recipients: [{ to: "collab@x.com", handle: "collabcreator" }] } });
  ck(!hr2.body.results[0].inhouse, "pre-check: in-house not flagged for own creator");
  // 실제 발송 경로: 다른 담당자 기록이 있어도 Luna 발송 성공
  out = await SC.sendBatch({ account: { email: L, name: "Luna", password: "x" }, campaign: camp, recipients: [{ to: "shared@x.com", creatorName: "Sh" }], admin: false });
  ck(out.results[0].ok === true, "send-core: Luna's follow-up to shared creator goes out");
  out = await SC.sendBatch({ account: { email: J, name: "Jinwon", password: "x" }, campaign: camp, recipients: [{ to: "web@x.com", creatorName: "W" }], admin: false });
  ck(out.results[0].ok === false && out.results[0].held, "send-core: never-sent staff still held");

  // 🔎 중복 검사: 본인 표시
  const lookup = require("../api/lookup.js");
  const lr = await call(lookup, { method: "POST", body: { queries: ["shared@x.com", "fresh@x.com"] } });
  const by = Object.fromEntries(lr.body.results.map(x => [x.query, x]));
  ck(by["shared@x.com"].mine === true && by["fresh@x.com"].mine === false, "🔎 mine flag for viewer");
  A.currentUser = () => ({ email: J, name: "Jinwon" });
  const lr2 = await call(lookup, { method: "POST", body: { queries: ["shared@x.com"] } });
  ck(lr2.body.results[0].mine === false, "🔎 mine false for other viewer");
  console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch(e => { console.log("THREW", e && e.stack || e); process.exit(1); });
