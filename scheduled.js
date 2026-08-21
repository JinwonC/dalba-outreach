// 예약 발송 처리 — 크론(15분 간격)이 부른다.
//
// 담당자가 "크리에이터 현지 시간 기준 이 시각에 보내 달라" 고 맡긴 작업(history.saveSchedule)을
// 기한이 되면 실제로 보낸다. 발송 자체는 send-core.sendBatch — 즉시 발송과 같은 코드라
// 중복 차단·리마인드 예약·CC·첨부가 똑같이 적용된다.
//
// ─── 큰 예약(수백 명)과 크론 제한시간 ────────────────────────────
// 함수 예산 안에서 보낸 만큼만 처리하고, 남은 수신자는 작업에 되써서 다음 실행이
// 이어받는다(leftover). 그래서 한 작업이 여러 크론 실행에 걸쳐 나눠 나갈 수 있다.
//
// ─── 발신 계정 ───────────────────────────────────────────────────
// 예약 시각에 담당자는 로그인해 있지 않다. NW_ACCOUNTS 에서 앱 비밀번호를 꺼내 보내므로
// **로그인(계정) 방식 배포에서만** 동작한다. 예약 후 담당자가 명단에서 빠지면 그 작업은
// 실패로 표시하고 건드리지 않는다.

const A = require("./auth.js");
const H = require("./history.js");
const C = require("./send-core.js");

// 기한이 된 예약을 보낸다. opts: { now, budgetMs }
async function processDue(opts) {
  const o = opts || {};
  if (!H.enabled()) return { skipped: "no-store", due: 0, sent: 0 };
  if (!A.enabled()) return { skipped: "no-accounts", due: 0, sent: 0 };
  const now = o.now ? new Date(o.now).getTime() : Date.now();
  const deadline = Date.now() + Math.max(5000, Number(o.budgetMs) || 30000);

  // onlyBy 가 있으면 그 담당자의 예약만 처리한다 (본인이 화면에서 "지금 처리" 를 누른 경우)
  const onlyBy = o.onlyBy ? String(o.onlyBy).toLowerCase() : "";
  const jobs = (await H.allSchedules())
    .filter(j => j && j.status === "pending")
    .filter(j => !onlyBy || String(j.by || "").toLowerCase() === onlyBy)
    .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));   // 이른 예약부터

  const summary = { due: 0, jobs: 0, sent: 0, held: 0, failed: 0, partial: 0 };

  for (const job of jobs) {
    const dueAt = Date.parse(job.at || "");
    if (!isFinite(dueAt) || dueAt > now) continue;   // 아직 기한 전
    summary.due++;
    if (Date.now() > deadline) break;                 // 예산 소진 — 다음 실행이 이어받는다

    const account = A.findByEmail(job.by);
    if (!account || !account.appPassword) {
      // 담당자가 명단에서 빠짐 — 보낼 수 없다. 실패로 남겨 화면에서 보이게 한다.
      await H.saveSchedule(Object.assign({}, job, {
        status: "failed", error: "담당자 계정이 명단에 없습니다: " + job.by, doneAt: new Date().toISOString()
      }));
      summary.failed++;
      continue;
    }

    const out = await C.sendBatch({
      account: {
        name: account.name || account.email.split("@")[0],
        email: account.email,
        password: account.appPassword,
        title: account.title || ""
      },
      campaign: job.campaign || {},
      recipients: job.recipients || [],
      force: Boolean(job.force),
      budgetMs: Math.max(3000, deadline - Date.now())
    });

    if (out.smtpError) {
      // SMTP 인증 실패 — 재시도해도 같을 가능성이 크므로 실패로 확정한다
      await H.saveSchedule(Object.assign({}, job, {
        status: "failed", error: out.smtpError, doneAt: new Date().toISOString()
      }));
      summary.failed++;
      continue;
    }

    const prevResults = Array.isArray(job.results) ? job.results : [];
    const allResults = prevResults.concat(out.results);
    const sent = allResults.filter(r => r.ok).length;
    const held = allResults.filter(r => r.held).length;

    if (out.leftover && out.leftover.length) {
      // 예산이 다 됐다 — 남은 수신자를 되써 두고 다음 크론 실행이 이어받는다
      await H.saveSchedule(Object.assign({}, job, {
        recipients: out.leftover, results: allResults,
        sent, held, status: "pending", startedAt: job.startedAt || new Date().toISOString()
      }));
      summary.partial++;
    } else {
      await H.saveSchedule(Object.assign({}, job, {
        recipients: [], results: allResults,
        sent, held, failed: allResults.length - sent - held,
        status: "done", doneAt: new Date().toISOString()
      }));
      summary.jobs++;
    }
    summary.sent += out.sent;
    summary.held += out.held;
    summary.failed += out.failed;

    if (Date.now() > deadline) break;
  }

  return summary;
}

module.exports = { processDue };
