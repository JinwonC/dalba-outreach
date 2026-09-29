// 테스트: 회신 스캔 UID 커서 — 예산으로 끊겨도 빈틈 없이 이어지고 증분으로 도는지
require("./helpers/stubs");
// Verify incremental UID-cursor reply scan: no gaps across budget-broken runs, and true incrementality.
process.env.NW_ACCOUNTS = JSON.stringify([{ id:"seoyeon", pw:"x", appPassword:"y", email:"seoyeon@dalba.com", name:"Seoyeon" }]);
process.env.KV_REST_API_URL = "https://stub.local"; process.env.KV_REST_API_TOKEN = "stub";

const H = require("../history.js");
const M = require("../mail.js");
const S = require("../sync.js");

const account = { email: "seoyeon@dalba.com", name: "Seoyeon" };

// ---- in-memory cursor store ----
const kv = new Map();
H.readRaw = async (k) => (kv.has(k) ? kv.get(k) : null);
H.writeRaw = async (k, v) => { kv.set(k, String(v)); };

// ---- recorded replies with real messageId dedup ----
const recorded = [];
const seenIds = new Set();
H.recordReplies = async (items) => { let recorded = 0, duplicate = 0; for (const x of items) { const o = await H.recordReply(x.rec, x.id); if (o.duplicate) duplicate++; else recorded++; } return { recorded, duplicate }; };
H.sentToSet = async () => new Set();
H.bookMerge = async () => 0;
H.recordReply = async (rec, id) => {
  if (id && seenIds.has(id)) return { duplicate: true };
  if (id) seenIds.add(id);
  recorded.push(rec);
  return { recorded: true };
};

// ---- simulate the mailbox: 50 inbound msgs, uids 1..50; every msg is from a contacted creator ----
let INBOX = [];
for (let u = 1; u <= 50; u++) {
  INBOX.push({ uid: u, messageId: "m" + u, at: new Date(2026, 4, 1 + u).toISOString(),
    subject: "re " + u, from: { email: "creator" + u + "@x.com", name: "C" + u }, toAll: [], ccAll: [] });
}
const contacted = new Map();
INBOX.forEach(m => contacted.set(m.from.email, { by: account.email, byName: account.name, at: "2026-05-01T00:00:00Z" }));

// BUDGET: fetch at most `BATCH` msgs per call, OLDEST-first within `take` (mimics deadline break).
let BATCH = 7;
M.readFolders = async (acc, o) => {
  const since = new Date(o.since);
  const min = Number((o.cursors || {}).INBOX) || 0;
  let uids = INBOX.filter(m => new Date(m.at) >= since).map(m => m.uid).sort((a,b)=>a-b);
  const fmax = uids.length ? uids[uids.length-1] : 0;
  if (min && fmax >= min) uids = uids.filter(u => u > min);
  const take = uids.slice(-(o.limit || 2000));
  const rows = take.slice(0, BATCH).map(u => Object.assign({ toAll: [], ccAll: [] }, INBOX.find(m => m.uid === u)));
  return { folders: [{ path: "INBOX", name: "INBOX", rows, total: take.length, truncated: take.length > rows.length, skipped: false }] };
};

function cursor(){ try { return Number(JSON.parse(kv.get("outreach:cursor:box3:seoyeon@dalba.com") || "{}").INBOX) || 0; } catch(_) { return 0; } }

(async () => {
  let ok=0, bad=0; const ck=(c,m)=>{ if(c) ok++; else { bad++; console.log("FAIL:", m); } };

  // Drive the cron-style incremental scan repeatedly until it stops advancing.
  let prev=-1, runs=0;
  while (cursor() !== prev && runs < 100) { prev = cursor(); await S.collectReplies(account, contacted, { useCursor: true }); runs++; }

  const gotUids = new Set(recorded.map(r => Number(r.from.match(/creator(\d+)@/)[1])));
  ck(recorded.length === 50, "all 50 replies recorded exactly once (got " + recorded.length + ")");
  ck(gotUids.size === 50, "no gaps: 50 distinct creators");
  for (let u=1;u<=50;u++) if(!gotUids.has(u)){ ck(false, "missing creator"+u); break; }
  ck(cursor() === 50, "cursor at max uid 50 (got " + cursor() + ")");
  ck(runs >= Math.ceil(50/BATCH), "took multiple budget-broken runs (" + runs + ")");

  // Incrementality: a NEW message arrives -> next run records only it.
  const before = recorded.length;
  INBOX.push({ uid: 51, messageId: "m51", at: new Date(2026,6,1).toISOString(), subject:"re 51", from:{email:"creator51@x.com",name:"C51"}, toAll:[], ccAll:[] });
  contacted.set("creator51@x.com", { by: account.email, byName: account.name, at:"2026-05-01T00:00:00Z" });
  await S.collectReplies(account, contacted, { useCursor: true });
  ck(recorded.length === before + 1, "incremental: exactly 1 new reply added (got +" + (recorded.length-before) + ")");
  ck(cursor() === 51, "cursor advanced to 51");

  // Re-run with no new mail -> nothing added (pure incremental, cheap).
  const before2 = recorded.length;
  await S.collectReplies(account, contacted, { useCursor: true });
  ck(recorded.length === before2, "no-op run adds nothing");

  // UID reset guard: mailbox UIDs reset below cursor -> full rescan (dedup keeps it exactly-once).
  INBOX = [{ uid: 1, messageId: "m51", at: new Date(2026,6,1).toISOString(), subject:"re 51", from:{email:"creator51@x.com",name:"C51"}, toAll:[], ccAll:[] }];
  const before3 = recorded.length;
  await S.collectReplies(account, contacted, { useCursor: true });
  ck(recorded.length === before3, "uid-reset: dedup prevents double-record (m51 already seen)");

  console.log(`\n${ok} passed, ${bad} failed`);
  process.exit(bad?1:0);
})();
