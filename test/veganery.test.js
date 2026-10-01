// 테스트: 🌿 Veganery 테마 — 템플릿 색상·로고, 실제 발송 첨부, 기록, 리마인드, 미리보기 설정
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
const T = require("../email-template.js");
const LG = require("../logos.js");
const IH = require("../inhouse.js");
IH.loadHandles = async () => ({ at: Date.now(), handles: new Set(), emails: new Map(), squashed: new Map(), tabs: [] });
let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };
const L = "luna@dalbausa.com";
(async () => {
  // ── 템플릿 ──
  const base = { to: "a@b.com", creatorName: "Ann", campaignTitle: "Spring", logoUrl: "cid:x" };
  const v = T.buildHtml(Object.assign({ theme: "veganery", brand: "Veganery" }, base));
  const d = T.buildHtml(Object.assign({ brand: "d'Alba" }, base));
  ck(v.includes("#8cc63f") && v.includes("#a6d45f") && !/#f4c842|#f7d24e/i.test(v), "veganery: yellow-green hero, no yellow");
  ck(d.includes("#f4c842") && !v.includes("#a9781a") && d.includes("#a9781a"), "dalba unchanged (yellow + amber accent)");
  ck(v.includes("height:58px") && d.includes("height:46px"), "logo height per theme");
  ck(T.buildHtml(Object.assign({ theme: "nope" }, base)).includes("#f4c842"), "unknown theme → dalba");
  ck(T.defaultSubject("veganery").includes("💚") && T.defaultSubject("dalba").includes("💛"), "default subject heart per theme");
  // 다른 테마로 만든 뒤에도 섞이지 않는다
  T.buildHtml(Object.assign({ theme: "veganery" }, base));
  ck(T.buildHtml(base).includes("#f4c842"), "theme does not leak between builds");

  // ── 로고 ──
  const va = LG.logoAttachment("veganery"), da = LG.logoAttachment("dalba");
  ck(va && va.cid === "veganerylogo@dalba" && va.content.length > 1000 && va.content.slice(1, 4).toString() === "PNG", "veganery logo file attached (PNG)");
  ck(da && da.cid === "dalbalogo@dalba" && !va.content.equals(da.content), "dalba logo separate");
  ck(/^data:image\/png;base64,/.test(LG.logoDataUrl("veganery")), "veganery data url for preview");

  // ── 실제 발송: 비거너리 로고 첨부 · 녹색 본문 · 기록 ──
  const sent = [];
  global.FAKE_NODEMAILER_MODULE = { exports: { createTransport: () => ({ verify: async () => true, close() {}, sendMail: async m => { sent.push(m); return { messageId: "<v@x>" }; } }) } };
  const SC = require("../send-core.js");
  const camp = { theme: "veganery", brand: "Veganery", subject: T.defaultSubject("veganery"), pitch: "p", campaignTitle: "Green", followup: { enabled: true, intervalDays: 3, messages: [] } };
  let out = await SC.sendBatch({ account: { email: L, name: "Luna", password: "x" }, campaign: camp, recipients: [{ to: "veg1@gmail.com", creatorName: "Vee" }], admin: false });
  ck(out.results[0].ok, "veganery send ok: " + JSON.stringify(out.results[0]));
  const m = sent[0];
  ck(m.attachments.some(a => a.cid === "veganerylogo@dalba") && !m.attachments.some(a => a.cid === "dalbalogo@dalba"), "veganery logo inline, not dalba");
  ck(m.html.includes("cid:veganerylogo@dalba") && m.html.includes("#8cc63f") && /💚/.test(m.subject) && /Veganery/.test(m.subject), "html uses veganery logo + green; subject: " + m.subject);
  await new Promise(r => setTimeout(r, 50));
  ck(JSON.parse(lists.get("outreach:log")[0]).theme === "veganery", "send log records theme");
  out = await SC.sendBatch({ account: { email: L, name: "Luna", password: "x" }, campaign: { brand: "d'Alba", pitch: "p", campaignTitle: "Y" }, recipients: [{ to: "dal1@gmail.com", creatorName: "Dee" }], admin: false });
  ck(sent[1].attachments.some(a => a.cid === "dalbalogo@dalba") && sent[1].html.includes("#f4c842"), "default send still d'Alba yellow");
  await new Promise(r => setTimeout(r, 50));
  ck(JSON.parse(lists.get("outreach:log")[0]).theme === undefined, "dalba sends don't add a theme field");

  // ── 리마인드도 첫 메일의 테마로 ──
  const plans = await H.allReminders();
  const plan = plans.find(p => p.to === "veg1@gmail.com");
  ck(plan && plan.theme === "veganery", "reminder plan keeps theme");
  await H.saveReminder(plan.key, Object.assign({}, plan, { nextAt: new Date(Date.now() - 60e3).toISOString() }));
  const R = require("../reminders.js");
  const before = sent.length;
  await R.sendDue({ budgetMs: 10000 });
  const rm = sent.slice(before).find(x => /veg1@gmail\.com/.test(JSON.stringify(x.to)));
  ck(rm && rm.attachments.some(a => a.cid === "veganerylogo@dalba") && rm.html.includes("#8cc63f"), "veganery reminder uses veganery logo + green");

  // ── 설정: 미리보기용 로고 둘 다 ──
  const api = require("../api/outreach-send.js");
  A.currentUser = () => ({ email: L, name: "Luna" });
  const g = await new Promise(res => { const o = { _s: 0, setHeader() {}, status(x) { this._s = x; return this; }, json(b) { res({ status: this._s, body: b }); } }; api({ method: "GET", headers: {}, query: {} }, o); });
  ck(g.body.logos && /^data:image\/png/.test(g.body.logos.veganery) && /^data:image\/png/.test(g.body.logos.dalba) && g.body.logos.veganery !== g.body.logos.dalba, "config gives both logos");
  console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch(e => { console.log("THREW", e.stack); process.exit(1); });
