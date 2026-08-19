// Vercel Serverless Function — 배포 경로: /api/thread
//
// 관리자가 **담당자 ↔ 크리에이터 협상 스레드**를 본문까지 열어 본다.
// 담당자가 아웃리치·네고를 잘 하고 있는지 관리자가 확인하려는 용도.
//
//   GET /api/thread?staff=<담당자 이메일>&peer=<크리에이터 이메일>
//
// ─── 프라이버시 · 스코프 ─────────────────────────────────────────
//   · **본인**은 자기 메일함(staff == 로그인 계정)을 언제나 볼 수 있다 — 발송 화면의
//     Mail Pipeline 에서 자기 협상 스레드를 여는 용도. 자기 메일함이라 권한 문제가 없다.
//   · **남의** 메일함(staff != 본인)은 관리자(ADMIN_EMAILS)만. 그 외에는 못 본다.
//   · 담당자 계정은 크리에이터 아웃리치 전용이라 개인·사내 메일이 없다 —
//     그래서 peer 를 회신 기록으로 재검증하지 않는다(정당한 대화를 막곤 했다).
//   · 본문은 **저장하지 않는다** — 열 때만 그때그때 IMAP 으로 받아 보여준다.
//   · 스레드는 그 담당자와 그 한 명(peer) 사이 메일만 받는다. 받은편지함 전체가 아니다.

const A = require("../auth.js");
const M = require("../mail.js");
const S = require("../sync.js");

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    if (!A.enabled()) { res.status(501).json({ error: "직원 계정(NW_ACCOUNTS)을 설정해야 합니다" }); return; }
    const me = A.currentUser(req);
    if (!me) { res.status(401).json({ error: "로그인이 필요합니다" }); return; }
    if (req.method !== "GET") { res.status(405).json({ error: "method not allowed" }); return; }

    const q = req.query || {};
    const staffEmail = String(q.staff || "").trim().toLowerCase();
    const peer = String(q.peer || "").trim().toLowerCase();
    if (!staffEmail || !peer) { res.status(400).json({ error: "staff 와 peer 가 필요합니다" }); return; }

    // 자기 메일함은 언제나, 남의 메일함은 관리자만.
    const mine = staffEmail === String(me.email || "").toLowerCase();
    if (!mine && !A.isAdmin(me)) { res.status(403).json({ error: "남의 대화는 관리자만 볼 수 있습니다" }); return; }

    const account = A.findByEmail(staffEmail);
    if (!account) { res.status(404).json({ error: "등록되지 않은 담당자입니다: " + staffEmail }); return; }

    // 담당자 계정은 크리에이터 아웃리치 전용이라 개인·사내 메일이 없다 — 그래서 peer 를
    // 회신 기록으로 재검증하지 않는다(그 검증이 회신 주소가 미묘하게 다를 때 정당한 대화를
    // 막곤 했다). 접근 통제는 위의 **관리자 전용** 잠금이 담당한다. 스레드는 그래도 그
    // 한 명(peer)과의 메일만 받는다 — 받은편지함 전체를 쏟아내지 않는다.
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
