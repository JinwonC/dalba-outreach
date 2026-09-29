// 테스트: 관리자도 담당자 목록·집계(요약·주차별)에 포함되는지
require("./helpers/stubs");
// Verify admins now appear in roster/summary/weekly after removing the exclusion.
process.env.NW_ACCOUNTS = JSON.stringify([
  { id: "jinwon", pw: "x", appPassword: "y", email: "jinwon.choi@dalba.com", name: "Jinwon (admin)" },
  { id: "luna", pw: "x", appPassword: "y", email: "luna@dalbausa.com", name: "Luna" }
]);
process.env.ADMIN_EMAILS = "jinwon.choi@dalba.com";
process.env.KV_REST_API_URL = "https://stub.local";
process.env.KV_REST_API_TOKEN = "stub";

const A = require("../auth.js");
const H = require("../history.js");

// canned data: admin (jinwon) sent + got a reply; luna sent + got a reply
const now = new Date().toISOString();
const sent = [
  { to: "creatorA@x.com", handle: "@a", by: "jinwon.choi@dalba.com", byName: "Jinwon (admin)", at: now },
  { to: "creatorB@x.com", handle: "@b", by: "luna@dalbausa.com", byName: "Luna", at: now },
];
const replies = [
  { from: "creatorA@x.com", fromName: "Creator A", at: now, subject: "re: hi", inbox: "jinwon.choi@dalba.com", by: "jinwon.choi@dalba.com", byName: "Jinwon (admin)" },
  { from: "creatorB@x.com", fromName: "Creator B", at: now, subject: "re: yo", inbox: "luna@dalbausa.com", by: "luna@dalbausa.com", byName: "Luna" },
];

H.enabled = () => true;
H.recent = async () => sent.slice();
H.recentBlocked = async () => [];
H.recentReplies = async () => replies.slice();
H.count = async () => 2;
H.approvalsIndex = async () => new Set();
H.allApprovals = async () => [];

const admin = require("../api/admin.js");

// stub currentUser -> admin
A.currentUser = () => ({ email: "jinwon.choi@dalba.com", name: "Jinwon (admin)" });

function run(view) {
  return new Promise((resolve) => {
    const req = { method: "GET", query: { view }, headers: {} };
    const res = {
      _s: 0, setHeader() {}, status(s) { this._s = s; return this; },
      json(o) { resolve({ status: this._s, body: o }); }
    };
    admin(req, res);
  });
}

(async () => {
  let ok = 0, bad = 0;
  const check = (cond, msg) => { if (cond) { ok++; } else { bad++; console.log("FAIL:", msg); } };

  const sum = await run("summary");
  const rowsSum = (sum.body && sum.body.staff) || [];
  const jinwonSum = rowsSum.find(r => String(r.email).toLowerCase() === "jinwon.choi@dalba.com");
  check(sum.status === 200, "summary 200");
  check(!!jinwonSum, "admin appears in summary rows");
  check(jinwonSum && jinwonSum.sent === 1, "admin sent counted (=1)");
  check(jinwonSum && jinwonSum.replied === 1, "admin reply counted (=1)");
  check((sum.body.accounts || []).some(a => String(a.email).toLowerCase() === "jinwon.choi@dalba.com"), "admin in roster/accounts dropdown");

  const wk = await run("weekly");
  const rowsWk = (wk.body && wk.body.rows) || [];
  const jinwonWk = rowsWk.find(r => String(r.email).toLowerCase() === "jinwon.choi@dalba.com");
  check(wk.status === 200, "weekly 200");
  check(!!jinwonWk, "admin appears in weekly rows");
  check(jinwonWk && jinwonWk.totalSent === 1, "admin weekly sent (=1)");
  check(jinwonWk && jinwonWk.totalReplied === 1, "admin weekly replied (=1)");

  const rep = await run("repliers");
  const rowsRep = (rep.body && rep.body.rows) || [];
  check(rep.status === 200, "repliers 200");
  check(rowsRep.some(r => (r.staff || []).some(s => /admin/i.test(s))), "admin shows as replied-to staff in repliers");

  console.log(`\n${ok} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
