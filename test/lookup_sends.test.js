// 테스트: 🔎 중복 검사의 발송 제목·발신자 목록 (저장 메일 합치기, 관리자 제목 숨김)
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
IH.loadHandles = async () => ({ at: Date.now(), handles: new Set(), emails: new Map(), squashed: new Map(), tabs: [] });
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const J = "jinwon.choi@dalba.com", L = "luna@dalbausa.com";
const accs = JSON.parse(process.env.NW_ACCOUNTS); const S = accs.find(a => a.email !== J && a.email !== L).email;
const day = d => new Date(Date.now() - d * 86400e3).toISOString();
const t5 = day(5), t5b = new Date(Date.parse(t5) + 60e3).toISOString();
(async () => {
  lists.set("outreach:log", [
    { to: "c@x.com", handle: "cc", at: t5, by: L, byName: "Luna", campaign: "Sept Promo", subject: "Luna tool subject" },
    { to: "c@x.com", at: day(40), by: J, byName: "Jinwon", campaign: "Aug", subject: "ADMIN TOOL SUBJECT" },
    { to: "c@x.com", at: day(50), by: L, byName: "Luna", campaign: "Imported webmail subj", source: "imap" },
    { to: "old@x.com", at: day(60), by: L, byName: "Luna", campaign: "OldCamp" }].map(x => JSON.stringify(x)));
  lists.set("outreach:replies", []);
  // 담당자 S 는 웹메일로 보냈고 주소록에만 있음
  await H.bookMerge("sent", S, new Map([["c@x.com", { n: 3, first: day(90), last: day(20), subj: "Webmail from S", name: "", box: "" }]]));
  await H.bookMerge("sent", J, new Map([["c@x.com", { n: 1, first: day(10), last: day(10), subj: "ADMIN WEBMAIL SECRET", name: "", box: "" }]]));
  // 메시지 DB — Luna 보낸편지함: 툴 발송(같은 시각 ±1분)과 추가 웹메일 2건, 받은 메일 1건
  await H.storeMessages(L, [
    { id: "<m1>", dir: "out", at: t5b, from: L, to: ["c@x.com"], subject: "Luna tool subject", text: "BODY1", peers: ["c@x.com"] },
    { id: "<m2>", dir: "out", at: day(30), from: L, to: ["c@x.com"], subject: "Luna follow-up", text: "BODY2", peers: ["c@x.com"] },
    { id: "<m3>", dir: "in", at: day(29), from: "c@x.com", to: [L], subject: "Re: from creator", text: "BODY3", peers: ["c@x.com"] }]);
  await H.storeMessages(J, [{ id: "<a1>", dir: "out", at: day(10), from: J, to: ["c@x.com"], subject: "ADMIN MSG SECRET", text: "ADMINBODY", peers: ["c@x.com"] }]);
  const lookup = require("../api/lookup.js");
  const call = (req) => new Promise(res => { const o = { _s: 0, setHeader() {}, status(x) { this._s = x; return this; }, json(b) { res({ status: this._s, body: b }); } }; lookup(Object.assign({ headers: {}, query: {} }, req), o); });

  A.currentUser = () => ({ email: L, name: "Luna" });
  const r = await call({ method: "POST", body: { queries: ["c@x.com", "@cc", "old@x.com", "new@x.com"] } });
  const by = Object.fromEntries(r.body.results.map(x => [x.query, x]));
  const c = by["c@x.com"];
  const inl = c.sends.map(x => (x.byName || "") + ":" + (x.subject || (x.hidden ? "HIDDEN" : "")));
  ck(c.sends.length === 6 && c.sendsTotal === 6, "ALL sends inline (msg DB + log + book): " + inl.join(" | "));
  ck(inl.filter(x => x === "Luna:Luna tool subject").length === 1, "tool send merged with stored msg");
  ck(c.sends.find(x => x.subject === "Luna tool subject").campaign === "Sept Promo" && !c.sends.find(x => x.subject === "Luna tool subject").mailbox, "merged tool send keeps campaign, not tagged 메일함");
  ck(inl.includes("Luna:Luna follow-up") && inl.includes("Luna:Imported webmail subj") && inl.some(x => /Webmail from S/.test(x)), "webmail, imported and book-summary sends inline");
  ck(!inl.some(x => /from creator/.test(x)), "incoming mail not listed as a send");
  ck(c.sends.every((x, i, a) => i === 0 || String(a[i - 1].at) >= String(x.at)), "newest first");
  ck(r.body.partial.sends === false && !r.body.sendsCut, "stored msgs loaded, not cut");
  const txt = JSON.stringify(r.body);
  ck(!/ADMIN TOOL SUBJECT|ADMIN WEBMAIL SECRET|ADMIN MSG SECRET|BODY/.test(txt), "no admin subjects / bodies for staff");
  ck(c.sends.filter(x => x.by === J).every(x => x.hidden && !x.subject) && c.sends.some(x => x.by === J), "admin sends shown as hidden (sender + date only)");
  ck(!/_emails|_ids/.test(txt), "internal fields stripped");
  ck(by["@cc"].sends.length >= 1, "handle query shows sends");
  ck(by["old@x.com"].sends[0].campaign === "OldCamp" && !by["old@x.com"].sends[0].subject, "old log without subject → campaign only");
  ck(by["new@x.com"].sends.length === 0 && by["new@x.com"].sendsTotal === 0, "clean → no sends");

  // 전체 보기
  const d = await call({ method: "GET", query: { q: "c@x.com", sends: "1" } });
  ck(d.status === 200, "detail 200: " + JSON.stringify(d.body).slice(0, 200));
  const subs = d.body.sends.map(x => (x.byName || "") + ":" + (x.subject || (x.hidden ? "HIDDEN" : "")));
  ck(subs.includes("Luna:Luna tool subject") && subs.filter(x => x === "Luna:Luna tool subject").length === 1, "tool send merged with stored msg (no dup): " + subs.join(" | "));
  ck(subs.includes("Luna:Luna follow-up"), "stored webmail send listed");
  ck(subs.includes("Luna:Imported webmail subj"), "imported send (not in msg DB) listed");
  ck(!subs.some(x => /from creator/.test(x)), "incoming mail excluded");
  ck(subs.some(x => /Webmail from S/.test(x)), "book-only staff summarized with last subject");
  ck(subs.filter(x => /HIDDEN/.test(x)).length >= 1 && !/SECRET|ADMIN TOOL|BODY/.test(JSON.stringify(d.body)), "admin subjects hidden in detail, no bodies");
  ck(d.body.sends.every((x, i, a) => i === 0 || String(a[i - 1].at) >= String(x.at)), "detail newest first");

  // 관리자 본인은 자기 제목을 본다
  A.currentUser = () => ({ email: J, name: "Jinwon" });
  const d2 = await call({ method: "GET", query: { q: "c@x.com", sends: "1" } });
  const t2 = JSON.stringify(d2.body);
  ck(/ADMIN MSG SECRET/.test(t2) && /ADMIN TOOL SUBJECT/.test(t2) || /ADMIN MSG SECRET/.test(t2), "admin owner sees own subjects: " + t2.slice(0, 300));
  ck(!/ADMINBODY/.test(t2), "still no bodies");
  console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})();
