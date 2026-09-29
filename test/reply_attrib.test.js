// 테스트: 회신은 메일함 주인에게 귀속되는지
require("./helpers/stubs");
// Verify replies are credited to the INBOX OWNER, not the global most-recent sender.
// Scenario: creator X was contacted by BOTH luna and seoyeon. X replied into SEOYEON's inbox.
// An OLD record has by=luna (wrong, from global contactedMap) but inbox=seoyeon (correct).
process.env.NW_ACCOUNTS = JSON.stringify([
  { id: "jinwon", pw: "x", appPassword: "y", email: "jinwon.choi@dalba.com", name: "Jinwon (admin)" },
  { id: "luna", pw: "x", appPassword: "y", email: "luna@dalbausa.com", name: "Luna" },
  { id: "seoyeon", pw: "x", appPassword: "y", email: "seoyeon@dalba.com", name: "Seoyeon" }
]);
process.env.ADMIN_EMAILS = "jinwon.choi@dalba.com";
process.env.KV_REST_API_URL = "https://stub.local";
process.env.KV_REST_API_TOKEN = "stub";

const A = require("../auth.js");
const H = require("../history.js");
const now = new Date().toISOString();

const sent = [
  { to: "creatorX@x.com", handle: "@x", by: "luna@dalbausa.com", byName: "Luna", at: "2026-05-01T00:00:00Z" },
  { to: "creatorX@x.com", handle: "@x", by: "seoyeon@dalba.com", byName: "Seoyeon", at: "2026-05-02T00:00:00Z" },
];
// OLD reply record: arrived in seoyeon's inbox, but by=luna (wrong global attribution)
const replies = [
  { from: "creatorX@x.com", fromName: "Creator X", at: now, subject: "re: collab",
    inbox: "seoyeon@dalba.com", by: "luna@dalbausa.com", byName: "Luna" },
];

H.enabled = () => true;
H.recent = async () => sent.slice();
H.recentBlocked = async () => [];
H.recentReplies = async () => replies.slice();
H.recentReminders = async () => [];
H.count = async () => 1;
H.approvalsIndex = async () => new Set();
H.allApprovals = async () => [];

const admin = require("../api/admin.js");
A.currentUser = () => ({ email: "jinwon.choi@dalba.com", name: "Jinwon (admin)" });

function run(query) {
  return new Promise((resolve) => {
    const req = { method: "GET", query, headers: {} };
    const res = { _s: 0, setHeader() {}, status(s) { this._s = s; return this; }, json(o) { resolve({ status: this._s, body: o }); } };
    admin(req, res);
  });
}

(async () => {
  let ok = 0, bad = 0;
  const check = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };

  // pipeline for SEOYEON -> should include the reply (inbox=seoyeon)
  const pSeo = await run({ view: "pipeline", by: "seoyeon@dalba.com" });
  const seoReplied = (pSeo.body.rows || []).reduce((n, r) => n + (Number(r.replies || r.replied || 0) || (r.reply ? 1 : 0)), 0);
  const seoHasX = JSON.stringify(pSeo.body.rows || []).includes("creatorX@x.com");
  check(pSeo.status === 200, "pipeline seoyeon 200");
  check(seoHasX, "seoyeon pipeline INCLUDES the reply that landed in her inbox");

  // pipeline for LUNA -> should NOT include it (it landed in seoyeon's inbox, not luna's)
  const pLuna = await run({ view: "pipeline", by: "luna@dalbausa.com" });
  const lunaHasReplyX = (pLuna.body.rows || []).some(r =>
    JSON.stringify(r).includes("creatorX@x.com") && JSON.stringify(r).toLowerCase().includes("repl"));
  // luna DID send to X so X may appear as a sent row; but the REPLY must be credited to seoyeon.
  // Assert luna's reply count for X is 0.
  const lunaXrow = (pLuna.body.rows || []).find(r => JSON.stringify(r).includes("creatorX@x.com"));
  const lunaXreplies = lunaXrow ? Number(lunaXrow.replies || lunaXrow.replied || 0) : 0;
  check(lunaXreplies === 0, "luna pipeline shows 0 replies for X (reply belongs to seoyeon's inbox)");

  // repliers -> creator X credited to Seoyeon (inbox owner), NOT Luna
  const rep = await run({ view: "repliers" });
  const xRow = (rep.body.rows || []).find(r => String(r.email).toLowerCase() === "creatorx@x.com");
  check(!!xRow, "repliers has creatorX");
  check(xRow && xRow.staff.some(s => /seoyeon/i.test(s)), "repliers credits Seoyeon");
  check(xRow && !xRow.staff.some(s => /luna/i.test(s)), "repliers does NOT credit Luna");
  check(xRow && String(xRow.inbox).toLowerCase() === "seoyeon@dalba.com", "repliers thread opens seoyeon inbox");

  // summary -> replied count on Seoyeon, not Luna
  const sum = await run({ view: "summary" });
  const staffRows = sum.body.staff || [];
  const seoSum = staffRows.find(r => String(r.email).toLowerCase() === "seoyeon@dalba.com");
  const lunaSum = staffRows.find(r => String(r.email).toLowerCase() === "luna@dalbausa.com");
  check(seoSum && seoSum.replied === 1, "summary: Seoyeon replied=1");
  check(lunaSum && lunaSum.replied === 0, "summary: Luna replied=0");

  // conversations -> reply grouped under Seoyeon
  const conv = await run({ view: "conversations" });
  const seoConv = (conv.body.rows || []).find(r => String(r.by).toLowerCase() === "seoyeon@dalba.com");
  const lunaConv = (conv.body.rows || []).find(r => String(r.by).toLowerCase() === "luna@dalbausa.com");
  check(!!seoConv && seoConv.byName === "Seoyeon", "conversations: Seoyeon group present with correct name");
  check(!lunaConv, "conversations: no Luna reply group (she got no reply)");

  console.log(`\n${ok} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
