// Vercel Serverless Function — 배포 경로: /api/backfill
//
// 담당자의 **보낸편지함을 읽어 발송 이력으로 가져온다.**
// 이 도구를 쓰기 전에 나간 메일도 중복 판정에 들어와야, 툴을 켠 날 이전에 접촉한
// 크리에이터에게 그대로 다시 나가는 일이 없다.
//
//   POST /api/backfill { user, since, dryRun:true }  → 미리보기 (쓰지 않음)
//   POST /api/backfill { user, since }               → 실제 가져오기
//   since 는 YYYY-MM-DD. 생략하면 HISTORY_SINCE (기본 2026-07-01)
//
// ─── 왜 미리보기가 먼저인가 ──────────────────────────────────────
// 보낸편지함에는 아웃리치가 아닌 메일이 섞여 있다. 그대로 밀어 넣으면 동료·거래처
// 주소가 크리에이터로 잡히고, 그 주소로는 앞으로 발송이 막힌다. 되돌리기 어려우므로
// **무엇이 들어갈지 먼저 보여주고** 담당자가 확인한 뒤에만 쓴다.
//
// ─── 무엇을 거르나 ───────────────────────────────────────────────
//   · 회사 도메인(NW_DOMAIN) 수신자 → 내부 메일이므로 제외
//   · 수신자가 많은 메일(6명 이상) → 아웃리치는 1:1 이다. 공지·회람으로 보고 제외
//   · 제목 포함 문구(subject) → 넣으면 그 문구가 든 메일만. 비우면 전부
//   · 이미 가져온 메일 → messageId 로 판별해 두 번 넣지 않는다

const A = require("../auth.js");
const H = require("../history.js");
const S = require("../sync.js");   // 메일함 → 이력 변환은 여기 한 곳에만 있다

// 관리자 판정은 auth.js 한 곳에서만 한다 (콤마·세미콜론·공백·줄바꿈 구분 모두 허용)
const isAdmin = A.isAdmin;

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch (_) { return {}; } }
  return b;
}

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    if (!A.enabled()) {
      res.status(501).json({ error: "직원 계정(NW_ACCOUNTS)을 설정해야 합니다" });
      return;
    }
    const me = A.currentUser(req);
    if (!me) { res.status(401).json({ error: "로그인이 필요합니다" }); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }

    if (!H.enabled()) {
      res.status(501).json({
        error: "발송 이력 저장소가 없어 가져올 수 없습니다 (Vercel → Storage → Upstash Redis)"
      });
      return;
    }

    const body = readBody(req);

    // 대상 계정 — 기본은 본인, 남의 메일함은 관리자만
    let account = me;
    const wanted = String(body.user || "").trim().toLowerCase();
    if (wanted && wanted !== String(me.email).toLowerCase()) {
      if (!isAdmin(me)) { res.status(403).json({ error: "다른 담당자의 메일함은 관리자만 가져올 수 있습니다" }); return; }
      account = A.findByEmail(wanted);
      if (!account) { res.status(404).json({ error: "등록되지 않은 담당자입니다: " + wanted }); return; }
    }

    // 언제부터 가져올지. 기본은 HISTORY_SINCE(없으면 2026-07-01) — 이 도구를 쓰기 전
    // 기간까지 이력에 넣어야 중복 판정과 실적 집계가 그 날부터 맞는다.
    const since = String(body.since || S.SINCE_DEFAULT);
    const limit = Math.max(1, Math.min(Number(body.limit) || 500, 2000));
    const dryRun = body.dryRun !== false;   // 기본은 미리보기 — 실수로 쓰지 않도록

    let read;
    try {
      read = await S.readSent(account, { since, limit, subject: body.subject });
    } catch (e) {
      res.status(502).json({
        error: "네이버웍스 IMAP 연결/인증 실패: " + String((e && e.message) || e),
        hint: "관리자센터에서 IMAP/POP3 사용이 허용됐는지, NW_ACCOUNTS 의 앱 비밀번호가 " +
              "'설정 > 보안 > 외부 앱 비밀번호' 값인지 확인하세요."
      });
      return;
    }

    const base = {
      user: account.email, path: read.path, since,
      windowDays: H.WINDOW_DAYS,
      scanned: read.scanned,
      truncated: read.truncated,
      candidates: read.rows.length,
      skipped: read.skipped
    };

    if (dryRun) {
      res.status(200).json(Object.assign(base, { dryRun: true, preview: read.rows.slice(0, 100) }));
      return;
    }

    const result = await S.writeSent(account, read.rows);

    res.status(200).json(Object.assign(base, {
      dryRun: false, result
    }));
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
