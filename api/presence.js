// Vercel Serverless Function — 배포 경로: /api/presence
//
// 실시간 접속 표시 (디스코드처럼 '지금 누가 들어와 있나').
// 서버리스라 연결을 열어 둘 수 없으므로, 열어 둔 화면이 45초마다 신호를 보낸다(하트비트).
//
//   POST /api/presence { page, view }   → 신호를 남기고 최근 5분 안의 접속자 목록을 받는다
//   POST /api/presence { leave:true }   → 창을 닫을 때 바로 빠진다
//
// 상태: 마지막 신호가 90초 안 → online(🟢 접속 중), 5분 안 → away(🟡 자리 비움).
// 이름·상태는 로그인한 모두가 본다. **어느 화면에 있는지는 관리자만** 본다.

const A = require("../auth.js");
const H = require("../history.js");

const ONLINE_MS = 90e3;

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch (_) { return {}; } }
  return b;
}
const clip = (v, n) => String(v == null ? "" : v).replace(/[^\w\-.:/ ]/g, "").slice(0, n);

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }
    if (!A.enabled() || !H.enabled()) { res.status(200).json({ enabled: false, people: [] }); return; }
    const me = A.currentUser(req);
    if (!me) { res.status(401).json({ error: "로그인이 필요합니다" }); return; }

    const body = readBody(req);
    const now = Date.now();
    const meEmail = H.normEmail(me.email);
    const list = await H.presencePing(meEmail, { name: me.name || "", page: clip(body.page, 12), view: clip(body.view, 24) }, now, Boolean(body.leave));
    const admin = A.isAdmin(me);
    const people = list
      .filter(p => !(body.leave && p.email === meEmail))
      .map(p => {
        const out = { email: p.email, name: p.name || p.email.split("@")[0], status: (now - p.at) < ONLINE_MS ? "online" : "away",
          agoSec: Math.max(0, Math.round((now - p.at) / 1000)), me: p.email === meEmail };
        if (admin) { out.page = p.page || ""; out.view = p.view || ""; }
        return out;
      })
      .sort((a, b) => (a.status === b.status ? 0 : a.status === "online" ? -1 : 1) || String(a.name).localeCompare(String(b.name)));
    res.status(200).json({ enabled: true, admin, people, online: people.filter(p => p.status === "online").length });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
