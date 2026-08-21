// Vercel Serverless Function — 배포 경로: /api/replies
//
// 받은편지함을 훑어 **우리가 아웃리치한 크리에이터의 회신**만 기록으로 남긴다.
// 남겨 둔 기록으로 일별·담당자별 회신 수를 세므로, 화면을 열 때마다 IMAP 을
// 뒤지지 않아도 된다 (담당자가 10명이면 그건 못 견딘다).
//
//   POST /api/replies { user, since }        → 그 담당자 받은편지함을 훑어 기록
//   POST /api/replies { all:true, since }    → 등록된 담당자 전원 (관리자만)
//   since 는 YYYY-MM-DD. 생략하면 HISTORY_SINCE (기본 2026-05-01)
//
// ─── 무엇을 기록하나 ─────────────────────────────────────────────
// 발신자가 **우리가 보낸 적 있는 주소**일 때만. 그 외 메일은 읽고 버린다.
// 제목·발신자·시각만 남기고 본문은 가져오지 않는다.
// 회신을 누가 담당했는지는 발송 기록에서 끌어와 함께 붙인다.
//
// ─── 왜 자동이 아닌가 ────────────────────────────────────────────
// 서버리스에는 상주 프로세스가 없다. 주기 실행이 필요하면 Vercel Cron 으로
// 이 엔드포인트를 부르면 되고, 그때까지는 관리자가 화면에서 [회신 수집] 을 누른다.

const A = require("../auth.js");
const H = require("../history.js");
const S = require("../sync.js");

// 회신도 발송 이력과 같은 날부터 본다 — 기준이 다르면 회신율이 말이 안 된다


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

    if (!A.enabled()) { res.status(501).json({ error: "직원 계정(NW_ACCOUNTS)을 설정해야 합니다" }); return; }
    const me = A.currentUser(req);
    if (!me) { res.status(401).json({ error: "로그인이 필요합니다" }); return; }
    if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }
    if (!H.enabled()) {
      res.status(501).json({ error: "발송 이력 저장소가 없어 회신을 셀 수 없습니다 (Vercel → Storage → Upstash Redis)" });
      return;
    }

    const body = readBody(req);
    const since = String(body.since || S.SINCE_DEFAULT);
    const limit = Math.max(1, Math.min(Number(body.limit) || 400, 1000));

    // 대상 계정 정하기 — 기본은 본인, 남의 메일함이나 전원은 관리자만
    let targets;
    if (body.all) {
      if (!isAdmin(me)) { res.status(403).json({ error: "전원 수집은 관리자만 할 수 있습니다" }); return; }
      targets = A.parseAccounts();
    } else {
      const wanted = String(body.user || "").trim().toLowerCase();
      if (wanted && wanted !== String(me.email).toLowerCase()) {
        if (!isAdmin(me)) { res.status(403).json({ error: "다른 담당자의 메일함은 관리자만 볼 수 있습니다" }); return; }
        const t = A.findByEmail(wanted);
        if (!t) { res.status(404).json({ error: "등록되지 않은 담당자입니다: " + wanted }); return; }
        targets = [t];
      } else {
        targets = [me];
      }
    }

    const contacted = await S.contactedMap();

    if (!contacted.size) {
      res.status(200).json({ contacted: 0, results: [], note: "발송 기록이 없어 대조할 대상이 없습니다" });
      return;
    }

    // 함수 제한시간(60초) 안에 못 끝내면 거기까지만 하고 남은 사람을 알려준다.
    // 조용히 자르면 "전원 수집했다" 고 오해한다.
    const deadline = Date.now() + 45e3;
    const results = [];
    const skipped = [];
    for (const acc of targets) {
      if (Date.now() > deadline) { skipped.push(acc.email); continue; }
      try {
        results.push(await S.collectReplies(acc, contacted, { since, limit }));
      } catch (e) {
        results.push({ user: acc.email, error: String((e && e.message) || e) });
      }
    }

    res.status(200).json({
      contacted: contacted.size,
      since,
      results,
      totals: {
        found: results.reduce((s, r) => s + (r.found || 0), 0),
        duplicate: results.reduce((s, r) => s + (r.duplicate || 0), 0),
        failed: results.filter(r => r.error).length
      },
      skipped: skipped.length ? skipped : undefined
    });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
