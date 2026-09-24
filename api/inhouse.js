// Vercel Serverless Function — 배포 경로: /api/inhouse
//
// 달바 인하우스 협업 크리에이터 리스트(핸들). 로그인한 사람은 누구나 볼 수 있다.
//   GET  /api/inhouse  → { configured, count, handles:[…], emailCount, tabs:[…], updatedAt, error? }
//   POST /api/inhouse  { queries:[…] } → 핸들·이메일 여러 개를 협업 리스트와 대조
//
// 발송 차단(관리자 제외)은 send-core 가 같은 목록으로 서버에서 강제한다. 이 화면은 열람용이다.

const A = require("../auth.js");
const IH = require("../inhouse.js");
const H = require("../history.js");

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch (_) { return {}; } }
  return b;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    if (A.enabled()) {
      const me = A.currentUser(req);
      if (!me) { res.status(401).json({ error: "로그인이 필요합니다" }); return; }
    } else {
      const PW = process.env.DASHBOARD_PASSWORD;
      if (PW) {
        const given = req.headers["x-dashboard-password"] || (req.query && req.query.pw) || "";
        if (given !== PW) { res.status(401).json({ error: "unauthorized" }); return; }
      }
    }

    if (!IH.configured()) {
      res.status(200).json({
        configured: false, count: 0, handles: [], tabs: [],
        error: "구글 서비스 계정(GOOGLE_SERVICE_ACCOUNT)이 설정되지 않았습니다"
      });
      return;
    }

    // POST { queries:[핸들|이메일, …] } → 각 입력이 협업 리스트의 누구인지 (핸들·이메일 모두 대조)
    if (req.method === "POST") {
      const body = readBody(req);
      const queries = (Array.isArray(body.queries) ? body.queries : []).map(x => String(x || "").trim()).filter(Boolean).slice(0, 2000);
      const match = await IH.matcher();
      const items = queries.map(q => EMAIL_RE.test(q) ? { to: q } : { handle: q });
      let links = [];
      try { links = await H.bridge(items); } catch (_) { links = []; }
      res.status(200).json({
        results: queries.map((q, i) => ({
          q, isEmail: Boolean(items[i].to),
          match: match(items[i], (links[i] && links[i].handles) || []) || null,
          linkedHandles: (links[i] && links[i].handles) || []
        }))
      });
      return;
    }

    res.status(200).json(await IH.summary());
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
