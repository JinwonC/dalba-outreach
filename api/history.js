// Vercel Serverless Function — 배포 경로: /api/history
//
//   GET  /api/history              → 이력 확인이 켜져 있는지 · 차단 기간
//   GET  /api/history?recent=200   → 최근 발송 기록 (누가·언제·누구에게)
//   POST /api/history              → { recipients:[{to,handle}] } 로 겹치는지 미리 확인
//
// 발송 화면이 명단을 붙여넣는 즉시 겹치는 사람을 표시하려고 쓴다.
// 실제 차단은 여기가 아니라 발송 시점(outreach-send)에서 다시 확인한다 —
// 미리보기와 발송 사이에 다른 담당자가 먼저 보낼 수 있기 때문.

const A = require("../auth.js");
const H = require("../history.js");

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch (_) { return {}; } }
  return b;
}

module.exports = async (req, res) => {
  try {
    // 발송 이력에는 크리에이터 연락처가 들어 있다 — 발송 API 와 같은 수준으로 막는다
    if (A.enabled()) {
      if (!A.currentUser(req)) { res.status(401).json({ error: "로그인이 필요합니다" }); return; }
    } else {
      const PW = process.env.DASHBOARD_PASSWORD;
      if (PW) {
        const given = req.headers["x-dashboard-password"] || (req.query && req.query.pw) || "";
        if (given !== PW) { res.status(401).json({ error: "unauthorized" }); return; }
      }
    }

    res.setHeader("Cache-Control", "no-store");
    const q = req.query || {};

    if (req.method === "GET") {
      const out = { enabled: H.enabled(), windowDays: H.WINDOW_DAYS };
      if (q.recent) out.recent = await H.recent(q.recent);
      res.status(200).json(out);
      return;
    }

    if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }

    const body = readBody(req);
    const recipients = Array.isArray(body.recipients) ? body.recipients : [];
    if (!recipients.length) { res.status(400).json({ error: "recipients 가 비어 있습니다" }); return; }
    if (recipients.length > 2000) { res.status(400).json({ error: "한 번에 2000명까지 확인할 수 있습니다" }); return; }

    const priors = await H.lookup(recipients);
    res.status(200).json({
      enabled: H.enabled(),
      windowDays: H.WINDOW_DAYS,
      held: priors.filter(Boolean).length,
      results: recipients.map((r, i) => ({ to: r.to, prior: priors[i] || null }))
    });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
