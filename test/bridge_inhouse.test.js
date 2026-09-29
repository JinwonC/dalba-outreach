// 테스트: 핸들 URL 정규화, 브리지, 이메일로 협업 리스트 대조, send-core 차단
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

// ---- stub nodemailer (SMTP) ----
const sentMail = [];
global.FAKE_NODEMAILER_MODULE = {
  exports: { createTransport: () => ({ verify: async () => true, sendMail: async m => { sentMail.push(m); return { messageId: "<id" + sentMail.length + ">" }; }, close() {} }) }
};

const H = require("../history.js");
const IH = require("../inhouse.js");

// in-house cache as the sheet would give it: yaniratips, sheet email jeanyanira@gmail.com, plus a short handle
IH.loadHandles = async () => {
  const c = { at: Date.now(), handles: new Set(["yaniratips", "abc", "_serahmichelle"]), emails: new Map([["jeanyanira@gmail.com", "yaniratips"]]), tabs: [] };
  // run the module's own finisher by matching through matchOne after building squashed like finish()
  const sq = new Map(); c.handles.forEach(h => { const k = h.replace(/[._\-]/g, ""); if (k.length >= 7) sq.set(k, h); }); c.squashed = sq;
  return c;
};

let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };

(async () => {
  // 1) URL normalization
  ck(H.normHandle("https://www.tiktok.com/@yaniratips?lang=en") === "yaniratips", "normHandle strips TikTok URL");
  ck(H.normHandle("@YaniraTips ") === "yaniratips", "normHandle @/case/space");

  // 2) matcher
  const m = await IH.matcher();
  let r;
  r = m({ to: "yaniratipsparati@gmail.com" }, []); ck(r && r.handle === "yaniratips" && r.via === "email-prefix", "yaniratipsparati@ → yaniratips (email-prefix)");
  r = m({ to: "JeanYanira@gmail.com" }, []);       ck(r && r.via === "sheet-email", "sheet email matched");
  r = m({ handle: "https://www.tiktok.com/@yaniratips" }, []); ck(r && r.via === "handle", "URL handle matched");
  r = m({ to: "abcdefgh@gmail.com" }, []);         ck(r === null, "short handle 'abc' does NOT prefix-match (min 7)");
  r = m({ to: "yaniratips@dalba.com" }, []);       ck(r === null, "company email ignored");
  r = m({ to: "someone@gmail.com" }, []);          ck(r === null, "unrelated email no match");
  r = m({ to: "other@gmail.com" }, ["yaniratips"]); ck(r && r.via === "linked", "linked handle via bridge matched");

  // 3) bridge from log
  await H.log({ to: "a+tag@x.com", handle: "https://www.tiktok.com/@foo", at: new Date().toISOString(), by: "seoyeon@dalba.com" });
  let [b1] = await H.bridge([{ to: "a@x.com" }]);
  ck(b1.handles[0] === "foo", "bridge email→handle (normalized, +tag stripped)");
  let [b2] = await H.bridge([{ handle: "@foo" }]);
  ck(b2.emails[0] === "a@x.com", "bridge handle→emails");

  // 4) dedup via linked key: seoyeon emailed E1 only; link E1↔H exists; luna sends E2+H → blocked
  const r1 = await H.reserve({ to: "e1@x.com", handle: "" }, { by: "seoyeon@dalba.com", byName: "Seoyeon" });
  ck(r1.ok, "seoyeon email-only reserve ok");
  await H.log({ to: "e1@x.com", handle: "hdl1", by: "seoyeon@dalba.com" });   // some later record links E1↔hdl1
  kv.delete("outreach:sent:h:hdl1");                                           // (simulate: handle key never reserved)
  const r2 = await H.reserve({ to: "e2@x.com", handle: "hdl1" }, { by: "luna@dalbausa.com", byName: "Luna" });
  ck(r2.ok === false && r2.prior && r2.prior.linked, "luna E2+H blocked via linked E1");
  ck(!kv.has("outreach:sent:e:e2@x.com"), "blocked attempt did not reserve E2");
  const r3 = await H.reserve({ to: "e2@x.com", handle: "hdl1" }, { by: "seoyeon@dalba.com", byName: "Seoyeon" });
  ck(r3.ok === true, "same staffer (seoyeon) allowed via linked self-record");
  const [lk] = await H.lookup([{ to: "e3@x.com", handle: "hdl1" }]);
  ck(lk && /seoyeon/.test(lk.by), "lookup finds prior through link");

  // 5) rebuildBridge from old log (URL-form handle; pair not yet linked)
  lists.get("outreach:log").push(JSON.stringify({ to: "old@y.com", handle: "https://www.tiktok.com/@oldcreator", at: new Date().toISOString(), by: "luna@dalbausa.com" }));
  ck(!(await H.bridgeReady()), "bridge not ready before rebuild");
  const rb = await H.rebuildBridge({ budgetMs: 5000 });
  ck(rb.done, "rebuild finished");
  let [b3] = await H.bridge([{ to: "old@y.com" }]);
  ck(b3.handles[0] === "oldcreator", "rebuild linked old URL-form pair");
  ck(kv.has("outreach:sent:h:oldcreator"), "rebuild re-keyed URL handle to proper handle key");
  ck(await H.bridgeReady(), "bridge marked ready");

  // 6) real send-core: non-admin sending to yaniratipsparati@gmail.com WITHOUT handle → held (in-house)
  const SC = require("../send-core.js");
  const account = { email: "luna@dalbausa.com", name: "Luna", password: "x" };
  const campaign = { brand: "d'Alba", campaignTitle: "Test", subject: "Hi {{creatorName}}", pitch: "hello", brandIntro: "x" };
  const out1 = await SC.sendBatch({ account, campaign, recipients: [{ to: "yaniratipsparati@gmail.com", creatorName: "Yanira" }], admin: false });
  const res1 = (out1.results || [])[0] || {};
  ck(res1.ok === false && res1.inhouse && res1.inhouseHandle === "yaniratips" && res1.inhouseVia === "email-prefix", "send-core holds yaniratipsparati@ (no handle) as in-house");
  ck(sentMail.length === 0, "nothing actually sent");
  const out2 = await SC.sendBatch({ account, campaign, recipients: [{ to: "fresh@gmail.com", creatorName: "Fresh", handle: "https://www.tiktok.com/@freshone" }], admin: false });
  ck(((out2.results || [])[0] || {}).ok === true, "normal recipient sends");
  await new Promise(r => setTimeout(r, 20)); const logged = JSON.parse(lists.get("outreach:log")[0]); console.log("LOG0", JSON.stringify(logged));
  ck(logged.handle === "freshone", "log stores normalized handle from URL");
  let [b4] = await H.bridge([{ to: "fresh@gmail.com" }]);
  ck(b4.handles[0] === "freshone", "send links email↔handle immediately");
  // admin can still send to in-house
  const out3 = await SC.sendBatch({ account: { email: "jinwon.choi@dalba.com", name: "Jinwon", password: "x" }, campaign, recipients: [{ to: "yaniratipsparati@gmail.com", creatorName: "Yanira" }], admin: true });
  ck(((out3.results || [])[0] || {}).ok === true, "admin exempt from in-house block");

  console.log(`\n${ok} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log("THREW", e && e.stack || e); process.exit(1); });
