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
const M = require("../mail.js");

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
  // 함수 제한시간(60초) 안에 반드시 응답한다 — 예산은 **요청 시작** 기준으로 잡는다.
  // (저장소 읽기 뒤에 메일함 예산을 따로 주면 둘이 합쳐 60초를 넘겨 JSON 대신 오류 페이지가 간다)
  const t0 = Date.now();
  const left = () => t0 + 52e3 - Date.now();
  try {
    res.setHeader("Cache-Control", "no-store");

    if (!A.enabled()) { res.status(501).json({ error: "직원 계정(NW_ACCOUNTS)을 설정해야 합니다" }); return; }
    const me = A.currentUser(req);
    if (!me) { res.status(401).json({ error: "로그인이 필요합니다" }); return; }
    // ─── GET ?diagnose=1&user=… — 회신 누락 점검 (실제 메일함 ↔ 기록 대조) ───
    // 메일함(받은편지함+사용자 폴더)의 외부 발신자를 사람 단위로 묶어 상태를 매긴다:
    //   recorded      회신으로 기록돼 있음
    //   pending       회신 조건은 맞는데 아직 기록 전 (자동 수집 대기 · 지금 수집으로 바로 반영)
    //   not-contacted 우리 발송 기록·이 메일함 보낸편지함 어디에도 그 주소로 보낸 흔적이 없음
    // 본인 메일함은 누구나, 남의 메일함은 관리자만. 제목·주소만 보고 본문은 읽지 않는다.
    if (req.method === "GET" && req.query && req.query.diagnose) {
      const wanted = String(req.query.user || me.email).trim().toLowerCase();
      if (wanted !== String(me.email).toLowerCase() && !isAdmin(me)) { res.status(403).json({ error: "다른 담당자의 메일함은 관리자만 볼 수 있습니다" }); return; }
      const acc = A.findByEmail(wanted);
      if (!acc) { res.status(404).json({ error: "등록되지 않은 담당자입니다: " + wanted }); return; }
      const since = String(req.query.since || S.SINCE_DEFAULT);
      // 저장소 읽기와 메일함 훑기를 **동시에** — 순서대로 하면 합쳐서 제한시간을 넘긴다
      const mailP = M.readFolders(acc, { since, limit: 5000, budgetMs: Math.max(8000, left() - 12000) })
        .then(m => ({ m }), e => ({ e }));
      const [contacted, sentTo, replyAll, sentToDone, boxCur] = await Promise.all([
        S.contactedMap(), H.sentToSet(acc.email), H.recentReplies(H.REPLY_MAX),
        H.readRaw("outreach:sentto:done:" + H.normEmail(acc.email)).catch(() => null),
        H.readRaw("outreach:cursor:box2:" + H.normEmail(acc.email)).catch(() => null)
      ]);
      const recorded = new Set(replyAll.filter(r => H.normEmail(r.inbox || r.by) === H.normEmail(acc.email)).map(r => H.normEmail(r.from)));
      const got = await mailP;
      if (got.e) { res.status(502).json({ error: "메일함을 읽지 못했습니다: " + String((got.e && got.e.message) || got.e) }); return; }
      const mail = got.m;
      const people = new Map();
      let scanned = 0;
      for (const f of mail.folders) for (const m of f.rows) {
        scanned++;
        const c = S.classify(m, acc, contacted, sentTo);
        if (c.kind === "internal" || c.kind === "none") continue;
        let p = people.get(c.e);
        if (!p) { p = { email: c.e, name: (m.from && m.from.name) || "", count: 0, lastAt: "", lastSubject: "", folders: new Set(), status: "" }; people.set(c.e, p); }
        p.count++; p.folders.add(f.path);
        const at = m.at ? new Date(m.at).toISOString() : "";
        if (at >= p.lastAt) { p.lastAt = at; p.lastSubject = m.subject || ""; }
        p.status = recorded.has(c.e) ? "recorded" : (c.kind === "reply" ? "pending" : "not-contacted");
      }
      const list = [...people.values()].map(p => Object.assign(p, { folders: [...p.folders] }));
      const cnt = k => list.filter(p => p.status === k).length;
      const order = { pending: 0, "not-contacted": 1, recorded: 2 };
      res.status(200).json({
        user: acc.email, name: acc.name || "", since,
        folders: mail.folders.map(f => ({ path: f.path, scanned: f.rows.length, total: f.total, truncated: f.truncated, skipped: f.skipped })),
        scanned, people: list.length,
        recorded: cnt("recorded"), pending: cnt("pending"), notContacted: cnt("not-contacted"),
        sentToSize: sentTo.size, sentToDone: sentToDone === "2", cursorStarted: Boolean(boxCur),
        rows: list.sort((a, b) => (order[a.status] - order[b.status]) || String(b.lastAt).localeCompare(String(a.lastAt))).slice(0, 500)
      });
      return;
    }

    if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }
    if (!H.enabled()) {
      res.status(501).json({ error: "발송 이력 저장소가 없어 회신을 셀 수 없습니다 (Vercel → Storage → Upstash Redis)" });
      return;
    }

    const body = readBody(req);
    const since = String(body.since || S.SINCE_DEFAULT);
    // 즉시 깊게 훑는 용도 — 상한을 넉넉히 (예전 1000 은 최신 1000통만 봐서 오래된 회신을 놓쳤다).
    const limit = Math.max(1, Math.min(Number(body.limit) || 20000, 20000));

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
    const deadline = t0 + 50e3;   // 요청 시작 기준 (기록 읽기에 쓴 시간도 포함)
    const results = [];
    const skipped = [];
    for (const acc of targets) {
      if (Date.now() > deadline) { skipped.push(acc.email); continue; }
      try {
        // 자동 수집과 **같은 경로**(보낸편지함 → 보낸 적 있는 주소 → 폴더별 커서로 회신)를 쓴다.
        // 커서 덕분에 메일이 많아 한 번에 못 끝나도, 다시 누르면 이어서 처리된다.
        const r = await S.syncAccount(acc, contacted, { until: deadline });
        results.push({
          user: acc.email, found: r.replies.found || 0, duplicate: r.replies.duplicate || 0,
          waiting: Boolean(r.replies.waiting), notContacted: r.replies.notContacted || 0, folders: r.folders
        });
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
        failed: results.filter(r => r.error).length,
        waiting: results.filter(r => r.waiting).length   // 보낸편지함을 아직 읽는 중 — 다시 누르면 이어서
      },
      skipped: skipped.length ? skipped : undefined
    });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
