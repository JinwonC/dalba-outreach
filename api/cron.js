// Vercel Serverless Function — 배포 경로: /api/cron
//
// **자동 동기화.** Vercel Cron 이 정해진 시각에 이 주소를 부르면, 담당자 메일함을 훑어
// 발송·회신을 이력에 채운다. 사람이 버튼을 눌러야만 갱신되는 상태를 없애기 위한 것.
//
//   vercel.json 의 "crons" 항목이 이 경로를 부른다.
//   GET /api/cron            → Vercel Cron 이 부르는 형태
//   GET /api/cron?force=1    → 커서를 무시하고 처음부터 (진단용, 인증 필요)
//
// ─── 왜 한 번에 전원을 안 도나 ───────────────────────────────────
// 함수 제한시간은 60초다. 담당자가 10명이면 메일함 20개를 여는 셈이라 한 번에 못 끝낸다.
// 그래서 **커서를 저장해 두고 이어서 돈다** — 매 실행마다 시간이 허락하는 만큼 처리하고
// 다음 실행이 그 다음 사람부터 이어받는다. 몇 번 돌면 전원이 한 바퀴 돈다.
//
// ─── 누가 부를 수 있나 ───────────────────────────────────────────
// Vercel Cron 이 붙이는 x-vercel-cron 헤더, 또는 CRON_SECRET 을 Bearer 로 준 요청만.
// 이 엔드포인트는 로그인 세션 없이 도므로, 아무나 부를 수 있으면 안 된다.
//   ※ CRON_SECRET 을 설정하면 Vercel 이 자동으로 Authorization 헤더에 실어 보낸다.

const A = require("../auth.js");
const H = require("../history.js");
const S = require("../sync.js");
const R = require("../reminders.js");
const Sch = require("../scheduled.js");

const CURSOR_KEY = "outreach:cron:cursor";
const STATUS_KEY = "outreach:cron:status";

// 실행 예산. Vercel 상한(60초)보다 넉넉히 앞에서 접어야 응답을 돌려줄 수 있다.
const BUDGET_MS = 45e3;

function authorized(req) {
  const h = req.headers || {};
  // Vercel Cron 이 직접 부른 경우
  if (h["x-vercel-cron"]) return true;
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;   // 비밀값이 없으면 외부 호출은 전부 거절
  const got = String(h.authorization || h.Authorization || "").replace(/^Bearer\s+/i, "").trim();
  return got === secret;
}

async function getCursor() {
  try {
    const raw = await H.readRaw(CURSOR_KEY);
    const n = Number(raw);
    return isFinite(n) && n >= 0 ? n : 0;
  } catch (_) { return 0; }
}

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    // 로그인한 관리자가 브라우저로 상태를 확인하는 것도 허용한다
    const me = A.enabled() ? A.currentUser(req) : null;
    const byAdmin = A.isAdmin(me);

    if (!authorized(req) && !byAdmin) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    if (!A.enabled()) { res.status(501).json({ error: "직원 계정(NW_ACCOUNTS)이 없습니다" }); return; }
    if (!H.enabled()) { res.status(501).json({ error: "이력 저장소가 없습니다 (Upstash Redis)" }); return; }

    const accounts = A.parseAccounts();
    if (!accounts.length) { res.status(200).json({ note: "담당자가 없습니다" }); return; }

    const q = req.query || {};
    const deadline = Date.now() + BUDGET_MS;

    // ─── 예약 발송을 **먼저** 처리한다 ──────────────────────────
    // 예약은 시각 약속이라 가장 시간에 민감하다. 크론이 15분마다 도는 주 목적이 이것과
    // 리마인드이므로 매 실행 처리한다. 큰 예약은 예산만큼 보내고 남은 수신자를 되써(leftover)
    // 다음 실행이 이어받는다.
    let scheduled = null;
    try { scheduled = await Sch.processDue({ budgetMs: Math.min(25e3, deadline - Date.now()) }); }
    catch (e) { scheduled = { error: String((e && e.message) || e) }; }

    // ─── 메일함 동기화는 **한 시간에 한 번**만 돈다 ──────────────
    // 크론은 예약·리마인드 때문에 15분마다 돌지만, 담당자 메일함 20개를 여는 무거운 동기화를
    // 매번 하면 저장소(Upstash) 요청이 15분마다 쌓여 한도를 넘고, 그러면 발송의 중복확인까지
    // 느려진다. 그래서 마지막 동기화로부터 55분이 안 지났으면 이번엔 건너뛴다(강제는 force=1).
    const SYNC_AT_KEY = "outreach:cron:syncAt";
    // 0 도 유효한 값(항상 동기화)이라 || 로 기본값을 주면 안 된다 — 명시됐는지로 판단한다
    const SYNC_EVERY_MS = (process.env.SYNC_EVERY_MS != null && process.env.SYNC_EVERY_MS !== "")
      ? Number(process.env.SYNC_EVERY_MS) : 55 * 60e3;
    let lastSyncAt = 0;
    try { lastSyncAt = Date.parse(await H.readRaw(SYNC_AT_KEY)) || 0; } catch (_) {}
    const doSync = q.force === "1" || (Date.now() - lastSyncAt >= SYNC_EVERY_MS);

    const results = [];
    let processed = 0, done = true, syncSkipped = !doSync, i = 0;
    if (doSync) {
      const contacted = await S.contactedMap();
      const start = q.force === "1" ? 0 : (await getCursor()) % accounts.length;
      i = start;
      // 한 바퀴를 넘지 않게, 그리고 예산이 남아 있는 동안만
      while (processed < accounts.length && Date.now() < deadline) {
        const acc = accounts[i % accounts.length];
        try {
          results.push(await S.syncAccount(acc, contacted, {}));
        } catch (e) {
          results.push({ user: acc.email, error: String((e && e.message) || e) });
        }
        i++; processed++;
      }
      done = processed >= accounts.length;
      // 한 바퀴를 다 돌았을 때만 "이번 동기화 끝" 으로 시각을 찍는다 (그래야 다음 55분 타이머 시작)
      if (done) { try { await H.writeRaw(SYNC_AT_KEY, new Date().toISOString()); } catch (_) {} }
    }

    const totals = {
      sent: results.reduce((s, r) => s + ((r.sent && r.sent.imported) || 0), 0),
      replies: results.reduce((s, r) => s + ((r.replies && r.replies.found) || 0), 0),
      failed: results.filter(r => r.error).length
    };

    // 회신 없는 건에 대한 자동 리마인드 — 매 실행 처리한다(예약과 함께 15분마다).
    // 남은 예산(함수 60초 안)만큼만 보내고, 다 못 보내면 다음 실행이 이어받는다.
    let reminders = null;
    try { reminders = await R.sendDue({ budgetMs: Math.max(6000, (deadline + 11e3) - Date.now()) }); }
    catch (e) { reminders = { error: String((e && e.message) || e) }; }

    const status = {
      at: new Date().toISOString(),
      accounts: accounts.length,
      processed,
      syncSkipped,          // 이번 실행은 동기화를 건너뛰었는지 (예약·리마인드만 처리)
      // 한 바퀴를 다 돌았는지 — 못 돌았으면 다음 실행이 이어받는다
      complete: done,
      totals,
      scheduled,
      reminders,
      errors: results.filter(r => r.error).map(r => ({ user: r.user, error: r.error }))
    };

    // 동기화를 돌린 경우에만 커서를 옮긴다 (건너뛴 실행이 커서를 리셋하면 안 된다)
    if (doSync) await H.writeRaw(CURSOR_KEY, String(done ? 0 : i % accounts.length));
    await H.writeRaw(STATUS_KEY, JSON.stringify(status));

    res.status(200).json(Object.assign({ ok: true, since: S.SINCE_DEFAULT }, status, { results }));
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
