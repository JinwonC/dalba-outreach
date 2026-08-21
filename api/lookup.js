// Vercel Serverless Function — 배포 경로: /api/lookup
//
// 중복 검사기. 크리에이터 **핸들 또는 이메일**을 넣으면, 전체 담당자(관리자 포함)의 발송
// 이력에서 그 사람에게 보낸 적이 있는지 · 누가 · 언제 보냈는지를 찾아 준다.
//
//   GET /api/lookup?q=creator@x.com   또는  ?q=@handle
//
// ─── 관리자도 포함한다 ───────────────────────────────────────────
// 관리자 페이지의 집계는 관리자 본인 발송을 빼지만, 이 검사기는 **누가 보냈든** 다 보여준다
// (진짜로 이미 접촉했는지 알아야 하므로). 로그인한 담당자면 누구나 쓸 수 있다.
//
// ─── 왜 로그 전체를 훑나 ──────────────────────────────────────────
// 예약(reserve) 키는 한 사람당 기록 하나뿐이라 "누가누가 보냈나" 전부를 못 준다. 그래서
// 발송 로그를 훑어 그 크리에이터에게 간 모든 발송을 모은다. 회신 로그도 함께 봐서 "회신까지
// 온 상대인지" 도 알려준다. 온디맨드(사람이 눌러 조회)라 매번 전부 읽어도 된다.

const A = require("../auth.js");
const H = require("../history.js");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    // 로그인 방식이면 세션이 필요하고, BYO 방식이면 공용 비밀번호로 이미 게이트를 지난다.
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

    if (!H.enabled()) {
      res.status(200).json({ historyEnabled: false, sent: [], replies: [], found: false });
      return;
    }

    const q = String((req.query && req.query.q) || "").trim();
    if (!q) { res.status(400).json({ error: "핸들 또는 이메일을 입력하세요" }); return; }

    // @ 가 들어간 이메일 형태면 이메일로, 아니면 핸들로 본다.
    const isEmail = EMAIL_RE.test(q);
    const emailQ = isEmail ? H.normEmail(q) : "";
    const handleQ = isEmail ? "" : H.normHandle(q);
    if (!emailQ && !handleQ) { res.status(400).json({ error: "검색어를 확인하세요" }); return; }

    const [sentAll, replyAll] = await Promise.all([
      H.recent(H.LOG_MAX),
      H.recentReplies(H.REPLY_MAX)
    ]);

    const byTime = (a, b) => String(b.at || "").localeCompare(String(a.at || ""));

    const matchSend = r =>
      (emailQ && H.normEmail(r.to) === emailQ) ||
      (handleQ && H.normHandle(r.handle) === handleQ);
    // 회신은 상대가 from 이고, 핸들이 없을 수 있으니 이메일 기준으로 본다
    const matchReply = r =>
      (emailQ && H.normEmail(r.from) === emailQ) ||
      (handleQ && H.normHandle(r.handle) === handleQ);

    const sent = sentAll.filter(matchSend).sort(byTime).map(r => ({
      to: r.to, name: r.name || "", handle: r.handle || "",
      by: r.by || "", byName: r.byName || r.by || "",
      at: r.at || "", campaign: r.campaign || "", forced: Boolean(r.forced)
    }));
    const replies = replyAll.filter(matchReply).sort(byTime).map(r => ({
      from: r.from, fromName: r.fromName || "",
      at: r.at || "", subject: r.subject || "",
      by: r.by || r.inbox || "", byName: r.byName || ""
    }));

    // 이 크리에이터를 접촉한 담당자들 (표시이름 기준, 중복 제거)
    const senders = [...new Set(sent.map(r => r.byName || r.by).filter(Boolean))];

    res.status(200).json({
      historyEnabled: true,
      query: q, email: emailQ, handle: handleQ,
      found: sent.length > 0,
      sentCount: sent.length,
      replyCount: replies.length,
      senders,
      sent, replies
    });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
