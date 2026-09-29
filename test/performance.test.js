// 테스트: 📈 성과 — 발송→회신→협업 전환 (담당자별·캠페인별, 첫 발송 이후 회신만, 핸들 연결, 기간·담당자 필터)
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
IH.loadHandles = async () => ({ at: Date.now(), handles: new Set(["collabby"]), emails: new Map(), squashed: new Map(), tabs: [] });
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const J = "jinwon.choi@dalba.com", L = "luna@dalbausa.com", S = "seoyeon@dalba.com";
const day = d => new Date(Date.now() - d * 86400e3).toISOString();
const call = (mod, user, req) => new Promise(res => { A.currentUser = () => user; const o = { _s: 0, setHeader() {}, status(x) { this._s = x; return this; }, json(b) { res({ status: this._s, body: b }); } }; mod(Object.assign({ headers: {}, query: {} }, req), o); });
(async () => {
  lists.set("outreach:log", [
    { to: "a@x.com", at: day(20), by: L, byName: "Luna", campaign: "Sept" },
    { to: "a@x.com", at: day(10), by: L, byName: "Luna", campaign: "Sept" },     // 같은 사람 두 번 → 1명
    { to: "b@x.com", handle: "bee", at: day(20), by: L, byName: "Luna", campaign: "Sept" },
    { to: "c@x.com", handle: "collabby", at: day(20), by: S, byName: "Seoyeon", campaign: "Oct" },
    { to: "d@x.com", at: day(20), by: S, byName: "Seoyeon", campaign: "Subject line", source: "imap" },
    { to: "old@x.com", at: day(100), by: L, byName: "Luna", campaign: "Old" }
  ].map(x => JSON.stringify(x)));
  lists.set("outreach:replies", [
    { from: "a@x.com", inbox: L, at: day(15) },            // 첫 발송(20일 전) 이후 → 회신
    { from: "b2@x.com", handle: "bee", inbox: L, at: day(5) }, // 다른 이메일이지만 같은 핸들 → 회신
    { from: "d@x.com", inbox: S, at: day(30) }               // 첫 발송 **전** → 회신 아님
  ].map(x => JSON.stringify(x)));
  const admin = require("../api/admin.js");
  let r = await call(admin, { email: J, name: "Jinwon" }, { method: "GET", query: { view: "performance", days: "60" } });
  ck(r.status === 200, "200");
  const t = r.body.totals;
  ck(t.contacted === 4 && t.replied === 2 && t.collab === 1, "totals (60 days, dedup, reply-after-send, linked handle, collab): " + JSON.stringify(t));
  const st = Object.fromEntries(r.body.staff.map(x => [x.staff, x]));
  ck(st[L].contacted === 2 && st[L].replied === 2 && st[L].collab === 0 && st[L].name === "Luna", "Luna: " + JSON.stringify(st[L]));
  ck(st[S].contacted === 2 && st[S].replied === 0 && st[S].collab === 1, "Seoyeon: " + JSON.stringify(st[S]));
  const cp = Object.fromEntries(r.body.campaigns.map(x => [x.campaign, x]));
  ck(cp["Sept"].contacted === 2 && cp["Sept"].replied === 2 && cp["Oct"].collab === 1 && cp["(네이버웍스에서 직접 보낸 메일)"].contacted === 1, "campaigns: " + JSON.stringify(r.body.campaigns));
  ck(r.body.inhouseChecked === true, "in-house checked");
  r = await call(admin, { email: J, name: "Jinwon" }, { method: "GET", query: { view: "performance" } });
  ck(r.body.totals.contacted === 5, "all time includes old send");
  r = await call(admin, { email: J, name: "Jinwon" }, { method: "GET", query: { view: "performance", days: "60", by: S } });
  ck(r.body.totals.contacted === 2 && r.body.staff.length === 1, "staff filter");
  // ── 제목별 회신율 ──
  const F = require("../funnel-lib.js");
  lists.set("outreach:log", [
    { to: "s1@x.com", name: "Ann Lee", at: day(20), by: L, campaign: "C", subject: "Paid Collab X Ann Lee", subjectTpl: "Paid Collab X {{name}}" },
    { to: "s2@x.com", name: "Bo", at: day(20), by: L, campaign: "C", subject: "Paid Collab X Bo", subjectTpl: "Paid Collab X {{name}}" },
    { to: "s3@x.com", name: "Cy", handle: "cyy", at: day(20), by: L, campaign: "Hi @cyy — collab?", source: "imap" },   // 웹메일: 실제 제목에서 핸들 치환
    { to: "s4@x.com", name: "Di", handle: "dii", at: day(20), by: L, campaign: "Re: Hi @dii — collab?", source: "imap" },
    { to: "s5@x.com", at: day(20), by: L, campaign: "Old tool send" }                                                     // 제목 없음 → 제외
  ].map(x => JSON.stringify(x)));
  lists.set("outreach:replies", [{ from: "s1@x.com", at: day(10) }, { from: "s4@x.com", at: day(25) }].map(x => JSON.stringify(x)));
  r = await call(admin, { email: J, name: "Jinwon" }, { method: "GET", query: { view: "performance" } });
  const sb = Object.fromEntries(r.body.subjects.map(x => [x.subject, x]));
  ck(sb["Paid Collab X {{name}}"] && sb["Paid Collab X {{name}}"].contacted === 2 && sb["Paid Collab X {{name}}"].replied === 1, "template grouping: " + JSON.stringify(r.body.subjects));
  ck(sb["Hi {{name}} — collab?"] && sb["Hi {{name}} — collab?"].contacted === 2 && sb["Hi {{name}} — collab?"].replied === 0, "webmail subjects normalized (Re: stripped, handle → {{name}}), reply before send not counted");
  ck(r.body.subjectsSkipped === 1 && r.body.subjects.length === 2, "sends without subject skipped: " + r.body.subjectsSkipped);
  ck(r.body.subjects[0].subject === "Paid Collab X {{name}}", "sorted by reply rate");
  ck(F.normSubject("FW: Re: Hello Jane", "Jane", "") === "Hello {{name}}", "normSubject");
  // 새 툴 발송은 제목 틀을 기록한다
  const SC = require("../send-core.js");
  await SC.sendBatch({ account: { email: L, name: "Luna", password: "x" }, campaign: { subject: "Collab with {{name}}?", pitch: "p", brand: "d'Alba", campaignTitle: "T" }, recipients: [{ to: "tplcheck@gmail.com", creatorName: "Zed" }], admin: false });
  await new Promise(r => setTimeout(r, 50));   // 발송 기록은 발송을 막지 않도록 기다리지 않고 남긴다
  const last = JSON.parse(lists.get("outreach:log")[0]);
  ck(last.to === "tplcheck@gmail.com" && last.subjectTpl === "Collab with {{name}}?" && last.subject === "Collab with Zed?", "tool send logs subject + template: " + JSON.stringify(last));
  await SC.sendBatch({ account: { email: L, name: "Luna", password: "x" }, campaign: { pitch: "p", brand: "d'Alba", campaignTitle: "T" }, recipients: [{ to: "tpl2@gmail.com", creatorName: "Zed" }], admin: false });
  await new Promise(r => setTimeout(r, 50));
  ck(JSON.parse(lists.get("outreach:log")[0]).subjectTpl === "(기본 제목)", "default subject labelled");
  console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch(e => { console.log("THREW", e.stack); process.exit(1); });
