// Vercel Serverless Function — 배포 경로: /api/videos
//
// 고른 제품(pid)의 **매출 상위 영상**을 돌려준다. 메일의 "바이럴 영상" 칸을
// 손으로 찾아 붙이지 않고 고르기만 하면 되도록.
//
//   GET /api/videos?pid=1732030444618027740        → 매출순 상위 20개
//   GET /api/videos?pid=…&limit=50
//   GET /api/videos?probe=1                        → 시트 설정 여부만 확인
//
// 출처는 구글 시트("영상성과" 탭)다. TikTok Shop API 를 다시 부르지 않는다 —
// 그 집계는 이미 시트에 매일 쌓이고 있고, 두 곳에서 같은 걸 계산하면 숫자가 갈린다.
//
// 매출 1 미만 영상은 애초에 빼고 준다. 성과 증거로 쓸 수 없는 숫자라서.

const A = require("../auth.js");
const S = require("../sheets.js");

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    // 크리에이터 핸들과 매출이 담긴 표다 — 발송 화면과 같은 수준으로 막는다
    if (A.enabled()) {
      if (!A.currentUser(req)) { res.status(401).json({ error: "로그인이 필요합니다" }); return; }
    } else {
      const PW = process.env.DASHBOARD_PASSWORD;
      if (PW) {
        const given = req.headers["x-dashboard-password"] || (req.query && req.query.pw) || "";
        if (given !== PW) { res.status(401).json({ error: "unauthorized" }); return; }
      }
    }

    const q = req.query || {};

    // 설정이 없으면 기능만 꺼진다 — 화면이 이 버튼을 아예 감춘다
    if (!S.configured()) {
      res.status(501).json({
        error: "영상 시트가 설정되지 않았습니다",
        need: ["GOOGLE_SERVICE_ACCOUNT (권장)", "또는 SHEET_CSV_URL"]
      });
      return;
    }
    if (q.probe === "1") { res.status(200).json({ ready: true, tab: S.SHEET_TAB }); return; }

    const pid = String(q.pid || "").trim();
    if (!pid) { res.status(400).json({ error: "pid 가 필요합니다" }); return; }

    const videos = await S.topVideos(pid, q.limit);
    res.status(200).json({ pid, count: videos.length, videos });
  } catch (e) {
    res.status(502).json({
      error: String((e && e.message) || e),
      hint: "서비스 계정을 쓴다면 시트를 그 계정 이메일에 '뷰어'로 공유했는지, " +
            "게시 CSV 를 쓴다면 주소가 맞는지 확인하세요."
    });
  }
};
