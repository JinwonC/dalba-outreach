// Vercel Serverless Function — 배포 경로: /api/inhouse
//
// 달바 인하우스 협업 크리에이터 리스트(핸들). 로그인한 사람은 누구나 볼 수 있다.
//   GET /api/inhouse  → { configured, count, handles:[…], tabs:[…], updatedAt, error? }
//
// 발송 차단(관리자 제외)은 send-core 가 같은 목록으로 서버에서 강제한다. 이 화면은 열람용이다.

const A = require("../auth.js");
const IH = require("../inhouse.js");

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

    res.status(200).json(await IH.summary());
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
