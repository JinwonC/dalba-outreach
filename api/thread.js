// Vercel Serverless Function — 배포 경로: /api/thread
//
// 관리자가 **담당자 ↔ 크리에이터 협상 스레드**를 본문까지 열어 본다.
// 담당자가 아웃리치·네고를 잘 하고 있는지 관리자가 확인하려는 용도.
//
//   GET /api/thread?staff=<담당자 이메일>&peer=<크리에이터 이메일>
//
// ─── 프라이버시 · 스코프 ─────────────────────────────────────────
//   · 관리자(ADMIN_EMAILS)만. 그 외에는 남의 메일함을 이 경로로도 못 본다.
//   · peer 는 그 담당자에게 **실제로 회신한 크리에이터**여야 한다(아웃리치 대화만).
//     이 검증이 없으면 관리자가 임의 주소로 담당자 메일함을 뒤질 수 있다.
//   · 본문은 **저장하지 않는다** — 열 때만 그때그때 IMAP 으로 받아 보여준다.
//   · 스레드는 그 담당자와 그 한 명(peer) 사이 메일만 받는다. 받은편지함 전체가 아니다.

const A = require("../auth.js");
const H = require("../history.js");
const M = require("../mail.js");
const S = require("../sync.js");

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    if (!A.enabled()) { res.status(501).json({ error: "직원 계정(NW_ACCOUNTS)을 설정해야 합니다" }); return; }
    const me = A.currentUser(req);
    if (!me) { res.status(401).json({ error: "로그인이 필요합니다" }); return; }
    if (!A.isAdmin(me)) { res.status(403).json({ error: "관리자만 대화를 볼 수 있습니다" }); return; }
    if (req.method !== "GET") { res.status(405).json({ error: "method not allowed" }); return; }

    const q = req.query || {};
    const staffEmail = String(q.staff || "").trim().toLowerCase();
    const peer = String(q.peer || "").trim().toLowerCase();
    if (!staffEmail || !peer) { res.status(400).json({ error: "staff 와 peer 가 필요합니다" }); return; }

    const account = A.findByEmail(staffEmail);
    if (!account) { res.status(404).json({ error: "등록되지 않은 담당자입니다: " + staffEmail }); return; }

    // ── 아웃리치 대화만 ── peer 가 이 담당자에게 회신한 크리에이터인지 확인한다.
    // 회신 기록은 발송보다 훨씬 적어 검증이 가볍고, 협상은 회신이 있어야 성립한다.
    if (H.enabled()) {
      const mine = e => H.normEmail(e) === H.normEmail(staffEmail);
      const target = H.normEmail(peer);
      const replies = await H.recentReplies(H.REPLY_MAX);
      const ok = replies.some(r => (mine(r.by) || mine(r.inbox)) && H.normEmail(r.from) === target);
      if (!ok) {
        res.status(403).json({ error: "이 담당자에게 회신한 크리에이터가 아닙니다 (아웃리치 대화만 볼 수 있습니다)" });
        return;
      }
    }

    const thread = await M.readThread(account, {
      peer,
      since: q.since || S.SINCE_DEFAULT,
      limit: Math.max(1, Math.min(Number(q.limit) || 50, 300))
    });

    res.status(200).json({ staff: staffEmail, peer, rows: thread.rows });
  } catch (e) {
    res.status(502).json({
      error: "메일함을 읽지 못했습니다: " + String((e && e.message) || e),
      hint: "그 담당자의 NW_ACCOUNTS 앱 비밀번호가 맞는지, 관리자센터에서 IMAP 사용이 켜져 있는지 확인하세요."
    });
  }
};
