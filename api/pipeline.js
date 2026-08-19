// Vercel Serverless Function — 배포 경로: /api/pipeline
//
// 발송 화면(index.html)의 "Mail Pipeline" 탭용. 로그인한 **본인**의 파이프라인만 준다.
// 관리자 화면(api/admin.js)과 달리 관리자 권한이 필요 없다 — 모든 담당자가 자기 것만 본다.
// 다른 사람 것은 절대 주지 않는다: target 은 항상 토큰의 본인 이메일로 고정한다.
//
//   GET /api/pipeline            → 본인 파이프라인 (단계별 크리에이터)
//   공통 파라미터: q(주소·이름·핸들·캠페인 검색), days(최근 N일)

const A = require("../auth.js");
const H = require("../history.js");
const { groupPipeline } = require("../pipeline-lib.js");

function matches(r, q) {
  if (!q) return true;
  const hay = [r.to, r.from, r.name, r.fromName, r.handle, r.subject, r.campaign]
    .filter(Boolean).join(" ").toLowerCase();
  return hay.indexOf(q) >= 0;
}

function withinDays(r, days) {
  if (!days) return true;
  const t = Date.parse(r.at || "");
  if (!isFinite(t)) return true;
  return Date.now() - t <= days * 86400e3;
}

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    // 로그인 계정을 안 쓰는 배포면 "본인" 을 특정할 수 없다 — 파이프라인 기능을 닫는다.
    if (!A.enabled()) {
      res.status(200).json({ loginEnabled: false, historyEnabled: false, rows: [] });
      return;
    }
    const me = A.currentUser(req);
    if (!me) { res.status(401).json({ error: "로그인이 필요합니다" }); return; }

    if (!H.enabled()) {
      res.status(200).json({
        loginEnabled: true, historyEnabled: false, me: A.publicUser(me), rows: [],
        error: "발송 이력 저장소가 연결되지 않아 보여줄 기록이 없습니다"
      });
      return;
    }

    const q = req.query || {};
    const days = Number(q.days) || 0;
    const needle = String(q.q || "").trim().toLowerCase();

    // 본인 이메일로 고정 — 쿼리로 다른 사람을 지정할 수 없게 한다.
    const target = String(me.email || "").toLowerCase();
    const win = r => withinDays(r, days) && matches(r, needle);

    const [sentAll, replyAll, remLog] = await Promise.all([
      H.recent(H.LOG_MAX),
      H.recentReplies(Math.min(H.LOG_MAX, H.REPLY_MAX)),
      H.recentReminders(H.LOG_MAX)
    ]);

    const mineSent = sentAll.filter(r => win(r) && String(r.by || "").toLowerCase() === target);
    const mineReplies = replyAll.filter(r => win(r) &&
      (String(r.by || "").toLowerCase() === target || String(r.inbox || "").toLowerCase() === target));
    const mineRem = remLog.filter(r => win(r) && String(r.by || "").toLowerCase() === target);

    res.status(200).json({
      loginEnabled: true,
      historyEnabled: true,
      me: A.publicUser(me),
      pipelineOf: target,
      rows: groupPipeline(mineSent, mineReplies, mineRem)
    });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
