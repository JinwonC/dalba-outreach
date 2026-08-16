// Vercel Serverless Function — 배포 경로: /api/mailbox
//
// 네이버웍스 메일함을 IMAP 으로 읽는다. SMTP 발송에 쓰는 그 **외부 앱 비밀번호**가
// IMAP 에도 그대로 통하므로 새로 등록할 것은 없다.
//
//   GET /api/mailbox?box=sent            → 내가 보낸 메일
//   GET /api/mailbox?box=inbox           → 내가 받은 메일
//   GET /api/mailbox?box=replies         → 받은 메일 중 **아웃리치한 크리에이터의 회신**만
//   GET /api/mailbox?ping=1              → 연결·로그인만 확인 (목록 안 읽음)
//   공통: days(기본 30) · limit(기본 200) · user(관리자만, 다른 담당자 메일함)
//
// ─── 제목·발신자만 읽는다 ────────────────────────────────────────
// 본문은 가져오지 않는다(envelope 만 fetch). 느려지기도 하지만, 무엇보다
// 아웃리치 현황을 보는 데 본문까지 읽을 이유가 없다. 필요 최소한만 본다.
//
// ─── 볼 수 있는 범위 ─────────────────────────────────────────────
// 담당자는 **자기 메일함만** 본다. 다른 사람 메일함은 ADMIN_EMAILS 에 등록된
// 관리자만 user= 로 지정해 볼 수 있다. 남의 받은편지함을 여는 일이므로
// 관리자 판정을 코드에 숨기지 않고 환경변수로 명시하게 했다.
//
// ─── 환경변수 ────────────────────────────────────────────────────
//   NW_IMAP_HOST  기본 imap.worksmobile.com
//   NW_IMAP_PORT  기본 993 (SSL)
//   ADMIN_EMAILS  다른 담당자 메일함을 볼 수 있는 관리자

const A = require("../auth.js");
const H = require("../history.js");
const M = require("../mail.js");   // IMAP 접속·폴더 탐색은 여기 한 곳에만 있다

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

const MAX_LIMIT = 500;

function isAdmin(u) {
  return Boolean(u && ADMIN_EMAILS.includes(String(u.email).toLowerCase()));
}

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    if (!A.enabled()) {
      res.status(501).json({ error: "직원 계정(NW_ACCOUNTS)을 설정해야 메일함을 읽을 수 있습니다" });
      return;
    }
    const me = A.currentUser(req);
    if (!me) { res.status(401).json({ error: "로그인이 필요합니다" }); return; }

    const q = req.query || {};

    // 어느 계정의 메일함을 볼 것인가 — 기본은 본인
    let target = me;
    const wanted = String(q.user || "").trim().toLowerCase();
    if (wanted && wanted !== String(me.email).toLowerCase()) {
      if (!isAdmin(me)) { res.status(403).json({ error: "다른 담당자의 메일함은 관리자만 볼 수 있습니다" }); return; }
      target = A.findByEmail(wanted);
      if (!target) { res.status(404).json({ error: "등록되지 않은 담당자입니다: " + wanted }); return; }
    }

    const kind = String(q.box || "sent").toLowerCase();
    const days = Math.max(1, Math.min(Number(q.days) || 30, 365));
    const limit = Math.max(1, Math.min(Number(q.limit) || 200, MAX_LIMIT));

    let mail;
    try {
      mail = await M.read(target, { kind, days, limit, pingOnly: q.ping === "1" });
    } catch (e) {
      res.status(502).json({
        error: "네이버웍스 IMAP 연결/인증 실패: " + String((e && e.message) || e),
        hint: "① 관리자센터에서 IMAP/POP3 사용이 허용됐는지 " +
              "② NW_ACCOUNTS 의 앱 비밀번호가 '설정 > 보안 > 외부 앱 비밀번호' 값인지 " +
              "③ 계정이 " + target.email + " 가 맞는지 확인하세요."
      });
      return;
    }

    if (q.ping === "1") {
      res.status(200).json({ ok: true, user: target.email, host: M.IMAP_HOST });
      return;
    }

    let rows;
    if (kind === "replies") {
      // 받은 메일 중 **우리가 아웃리치한 주소에서 온 것만** 추린다
      const log = H.enabled() ? await H.recent(H.LOG_MAX) : [];
      const contacted = new Map();
      log.forEach(r => { const k = H.normEmail(r.to); if (k) contacted.set(k, r); });

      rows = mail.rows.map(m => {
        const hit = contacted.get(H.normEmail(m.from.email));
        if (!hit) return null;
        return {
          uid: m.uid, at: m.at, subject: m.subject,
          from: m.from.email, fromName: m.from.name,
          outreach: { by: hit.by, byName: hit.byName, campaign: hit.campaign, sentAt: hit.at }
        };
      }).filter(Boolean);
    } else {
      rows = mail.rows.map(m => ({
        uid: m.uid, at: m.at, subject: m.subject,
        from: m.from.email, fromName: m.from.name,
        to: m.to.email, toName: m.to.name,
        recipients: m.toAll.concat(m.ccAll).map(x => x.email)
      }));
    }

    res.status(200).json({
      user: target.email, box: kind, path: mail.path, days, count: rows.length,
      // 상한에 걸렸는지 알려 준다 — 전부라고 오해하면 판단이 틀어진다
      truncated: mail.truncated,
      rows
    });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
