// 테스트: ⛔ 반송 주소 — 알림 해석, 동기화로 자동 등록, 발송 차단, 사전 확인·중복 검사 표시, 관리자 해제
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
const B = require("../bounce-lib.js");
const S = require("../sync.js");
const IH = require("../inhouse.js");
IH.loadHandles = async () => ({ at: Date.now(), handles: new Set(), emails: new Map(), squashed: new Map(), tabs: [] });
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const J = "jinwon.choi@dalba.com", L = "luna@dalbausa.com", S2 = "seoyeon@dalba.com";
const day = d => new Date(Date.now() - d * 86400e3).toISOString();
const call = (mod, user, req) => new Promise(res => { A.currentUser = () => user; const o = { _s: 0, setHeader() {}, status(x) { this._s = x; return this; }, json(b) { res({ status: this._s, body: b }); } }; mod(Object.assign({ headers: {}, query: {} }, req), o); });
(async () => {
  // ── 해석 ──
  const sentTo = e => ["gone@gmail.com", "full@gmail.com", "kgone@naver.com", "dsn@x.com"].includes(e);
  const o = { me: L, isInternal: e => /@dalba(usa)?\.com$/.test(e), sentTo };
  ck(B.isBounceMessage({ from: { email: "MAILER-DAEMON@worksmobile.com" }, subject: "x" }) && B.isBounceMessage({ from: "a@b.com", subject: "Undeliverable: Collab" }) && !B.isBounceMessage({ from: "c@x.com", subject: "Re: Collab" }), "bounce message detection");
  let r = B.failedRecipients("Delivery to the following recipient failed permanently:\n\n  gone@gmail.com\n\nThe email account that you tried to reach does not exist. 550 5.1.1 luna@dalbausa.com other@unrelated.com", o);
  ck(r.length === 1 && r[0].email === "gone@gmail.com", "gmail-style hard bounce, only an address we sent to: " + JSON.stringify(r));
  r = B.failedRecipients("<full@gmail.com>: 452 4.2.2 The email account that you tried to reach is over quota. Try again later.", o);
  ck(r.length === 0, "soft bounce (mailbox full) not recorded");
  r = B.failedRecipients("받는 사람 kgone@naver.com 이(가) 존재하지 않는 주소입니다.", o);
  ck(r.length === 1 && r[0].email === "kgone@naver.com", "Korean bounce");
  r = B.failedRecipients("Reporting-MTA: dns; mx\nFinal-Recipient: rfc822; dsn@x.com\nAction: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 User unknown\n(copy of original to gone@gmail.com)", o);
  ck(r.length === 1 && r[0].email === "dsn@x.com", "DSN Final-Recipient preferred");
  r = B.failedRecipients("<gone@gmail.com>: host mx said: 550 Message rejected as spam by content filter", o);
  ck(r.length === 0, "550 spam/policy rejection is not a missing address");
  r = B.failedRecipients("550 5.1.1 user unknown: stranger@x.com", o);
  ck(r.length === 0, "address we never sent to is ignored");
  ck(B.isHardSmtpError({ responseCode: 550, response: "550 5.1.1 <a@b.com>: Recipient address rejected: User unknown" }) && !B.isHardSmtpError({ responseCode: 421, response: "421 try again later" }) && !B.isHardSmtpError({ responseCode: 550, response: "550 spam policy" }), "SMTP hard error detection");

  // ── 동기화: 받은편지함의 반송 알림 → 발송 제외 ──
  const m = (uid, date, subject, from, to, body) => ({ uid, id: "<b" + uid + ">", date, subject, from, to, body });
  global.FAKE = { boxes: [{ path: "INBOX", name: "INBOX" }, { path: "보낸 메일함", name: "보낸 메일함" }],
    msgs: { "보낸 메일함": [m(1, day(20), "Collab", L, ["gone@gmail.com"]), m(2, day(20), "Collab", L, ["alive@gmail.com"])],
      INBOX: [m(1, day(19), "Undelivered Mail Returned to Sender", "MAILER-DAEMON@worksmobile.com", [L], "550 5.1.1 <gone@gmail.com>: Recipient address rejected: User unknown"),
              m(2, day(18), "Re: Collab", "alive@gmail.com", [L], "sounds good, but my old address unknown@gmail.com does not exist")] } };
  const acct = A.findByEmail(L);
  const res = await S.syncAccount(acct, await S.contactedMap(), { until: Date.now() + 60e3 });
  ck(res.bounces && res.bounces.added === 1, "sync found 1 bounce: " + JSON.stringify(res.bounces));
  let [sup] = await H.suppressCheck([{ to: "gone@gmail.com" }]);
  ck(sup && sup.type === "bounce" && sup.source === "imap", "gone@gmail.com suppressed as bounce");
  [sup] = await H.suppressCheck([{ to: "alive@gmail.com" }]);
  ck(!sup, "creator reply mentioning 'does not exist' is not a bounce");
  const res2 = await S.syncAccount(acct, await S.contactedMap(), { until: Date.now() + 60e3 });
  ck(res2.bounces && res2.bounces.scanned === 0, "cursor: second sync reads no old notices");

  // ── 발송 차단: 반송 주소는 누구도 (관리자·강제 포함) ──
  const SC = require("../send-core.js");
  const camp = { subject: "Hi", pitch: "p", brand: "d'Alba", campaignTitle: "T" };
  let out = await SC.sendBatch({ account: { email: J, name: "Jinwon", password: "x" }, campaign: camp, recipients: [{ to: "gone@gmail.com", creatorName: "G" }], admin: true, force: true });
  ck(out.results[0].ok === false && out.results[0].suppressed === "bounce", "admin force send to bounced address is held: " + JSON.stringify(out.results[0]));
  // 연결된 핸들로도: gone 에 핸들을 연결해 두면, 다른 이메일 + 같은 핸들도 막힌다? (핸들은 이메일 반송과 별개 — 막지 않음)
  out = await SC.sendBatch({ account: { email: J, name: "Jinwon", password: "x" }, campaign: camp, recipients: [{ to: "fresh1@gmail.com", creatorName: "F" }], admin: true });
  ck(out.results[0].ok === true, "normal address still sends");

  // ── SMTP 즉시 거절 → 반송 기록 ──
  global.FAKE_NODEMAILER_MODULE = { exports: { createTransport: () => ({ verify: async () => true, close() {}, sendMail: async () => { const e = new Error("550 5.1.1 Recipient address rejected: User unknown"); e.responseCode = 550; e.response = "550 5.1.1 <nobody@gmail.com>: Recipient address rejected: User unknown"; throw e; } }) } };
  out = await SC.sendBatch({ account: { email: L, name: "Luna", password: "x" }, campaign: camp, recipients: [{ to: "nobody@gmail.com", creatorName: "N" }], admin: false });
  global.FAKE_NODEMAILER_MODULE = null;
  [sup] = await H.suppressCheck([{ to: "nobody@gmail.com" }]);
  ck(out.results[0].ok === false && sup && sup.source === "smtp", "SMTP hard reject recorded as bounce");

  // ── 사전 확인 · 중복 검사 ──
  const hist = require("../api/history.js");
  let hr = await call(hist, { email: L, name: "Luna" }, { method: "POST", body: { recipients: [{ to: "gone@gmail.com" }, { to: "fine@gmail.com" }] } });
  ck(hr.body.results[0].suppressed && hr.body.results[0].suppressed.type === "bounce" && !hr.body.results[1].suppressed, "pre-check returns suppressed");
  const lookup = require("../api/lookup.js");
  const lr = await call(lookup, { email: L, name: "Luna" }, { method: "POST", body: { queries: ["gone@gmail.com", "fine@gmail.com"] } });
  ck(lr.body.results[0].suppressed && lr.body.results[0].suppressed.type === "bounce" && !lr.body.results[1].suppressed, "🔎 lookup returns suppressed");
  ck(!/_handles|_emails/.test(JSON.stringify(lr.body)), "internal fields stripped");

  // ── 관리자 목록 · 지우기 ──
  const admin = require("../api/admin.js");
  let ar = await call(admin, { email: J, name: "Jinwon" }, { method: "GET", query: { view: "suppress" } });
  ck(ar.status === 200 && ar.body.rows.length === 2 && ar.body.rows.every(x => x.type === "bounce"), "admin lists suppressions: " + JSON.stringify(ar.body.rows && ar.body.rows.map(x => x.value)));
  ar = await call(admin, { email: L, name: "Luna" }, { method: "GET", query: { view: "suppress" } });
  ck(ar.status === 403, "staff can't open admin list");
  ar = await call(admin, { email: J, name: "Jinwon" }, { method: "POST", body: { action: "unsuppress", fields: ["e:gone@gmail.com"] } });
  [sup] = await H.suppressCheck([{ to: "gone@gmail.com" }]);
  ck(ar.body.removed === 1 && !sup, "admin removes → can send again");
  // 수신 거부는 반송으로 덮지 않는다
  await H.suppressAdd([{ email: "keep@x.com", type: "dnc", reason: "asked", addedBy: L }]);
  await H.suppressAdd([{ email: "keep@x.com", type: "bounce", reason: "550" }]);
  [sup] = await H.suppressCheck([{ to: "keep@x.com" }]);
  ck(sup.type === "dnc", "dnc not overwritten by bounce");
  console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch(e => { console.log("THREW", e.stack); process.exit(1); });
