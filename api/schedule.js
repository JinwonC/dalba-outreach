// Vercel Serverless Function — 배포 경로: /api/schedule
//
// 예약 발송 관리. 담당자가 "크리에이터 **현지 시간** 기준 이 시각에 보내 달라" 고 맡긴다.
// 미국 크리에이터에게는 미국이 활발한 시간, 영국은 영국 시간에 맞춰 보내기 위한 것.
//
//   POST   /api/schedule   { campaign, recipients, force, when:{ date, time, tz } } → 예약 생성
//   GET    /api/schedule   → 내 예약 목록 (관리자는 ?all=1 로 전체)
//   DELETE /api/schedule?id=… → 내 예약 취소 (대기 중인 것만)
//
// ─── 시간대 변환은 서버가 한다 ───────────────────────────────────
// 담당자가 고른 현지 날짜·시각 + IANA 시간대를 UTC 시각으로 바꾼다. 서머타임(DST)은
// Intl 이 시간대 규칙으로 알아서 처리한다 — 브라우저마다 다른 계산을 믿지 않는다.
//
// ─── 왜 로그인 방식에서만 되나 ───────────────────────────────────
// 예약 시각에 담당자는 로그인해 있지 않다. 서버(NW_ACCOUNTS)가 앱 비밀번호를 갖고
// 있어야 대신 보낼 수 있다. BYO 방식은 비밀번호가 브라우저에만 있어 예약이 불가능하다.

const A = require("../auth.js");
const H = require("../history.js");
const Sch = require("../scheduled.js");

const MAX_RECIPIENTS = 500;          // 예약 하나당 수신자 상한 (크론이 여러 번에 나눠 보낸다)
const MAX_AHEAD_DAYS = 60;           // 너무 먼 미래는 실수일 가능성이 크다
const MAX_CAMPAIGN_BYTES = 700 * 1024;   // 저장소 요청 상한(1MB) 아래로 — 첨부 이미지 포함 스냅샷
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 화면에 내보내는 시간대 선택지 (크리에이터 활동 지역 기준)
const TZ_PRESETS = [
  { tz: "America/New_York",    label: "🇺🇸 미국 동부 (뉴욕)" },
  { tz: "America/Chicago",     label: "🇺🇸 미국 중부 (시카고)" },
  { tz: "America/Denver",      label: "🇺🇸 미국 산악 (덴버)" },
  { tz: "America/Los_Angeles", label: "🇺🇸 미국 서부 (LA)" },
  { tz: "Europe/London",       label: "🇬🇧 영국 (런던)" },
  { tz: "Asia/Ho_Chi_Minh",    label: "🇻🇳 베트남 (호치민)" },
  { tz: "Asia/Singapore",      label: "🇸🇬 싱가포르" },
  { tz: "Asia/Tokyo",          label: "🇯🇵 일본 (도쿄)" },
  { tz: "Asia/Seoul",          label: "🇰🇷 한국 (서울)" }
];

function validTz(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; }
  catch (_) { return false; }
}

// 어떤 순간(ts)에 그 시간대의 벽시계가 몇 시를 가리키는지 — UTC ms 로 환산해 돌려준다
function wallInZone(ts, tz) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).formatToParts(new Date(ts));
  const g = t => Number((p.find(x => x.type === t) || {}).value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
}

// 현지 날짜·시각(tz 기준)을 UTC 시각(ms)으로. DST 경계까지 맞도록 두 번 보정한다.
function utcFromZoned(dateStr, timeStr, tz) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || "").trim());
  const tm = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || "").trim());
  if (!dm || !tm) return NaN;
  const wallUTC = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2]));
  let ts = wallUTC;
  for (let i = 0; i < 2; i++) ts += wallUTC - wallInZone(ts, tz);
  return ts;
}

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch (_) { return {}; } }
  return b;
}

// 화면 목록용 — 캠페인 전문은 크므로 요약만 내보낸다
function publicJob(j) {
  return {
    id: j.id, at: j.at, tz: j.tz, local: j.local,
    by: j.by, byName: j.byName,
    campaign: (j.campaign && j.campaign.campaignTitle) || "",
    recipients: Array.isArray(j.recipients) ? j.recipients.length : 0,
    status: j.status, sent: j.sent || 0, held: j.held || 0,
    error: j.error || undefined, createdAt: j.createdAt, doneAt: j.doneAt
  };
}

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    if (!A.enabled()) {
      res.status(501).json({ error: "예약 발송은 직원 계정(NW_ACCOUNTS) 방식에서만 쓸 수 있습니다" });
      return;
    }
    const me = A.currentUser(req);
    if (!me) { res.status(401).json({ error: "로그인이 필요합니다" }); return; }
    if (!H.enabled()) {
      res.status(501).json({ error: "예약을 저장할 곳이 없습니다 (Vercel → Storage → Upstash Redis)" });
      return;
    }

    const meEmail = String(me.email || "").toLowerCase();
    const admin = A.isAdmin(me);

    // ─── GET: 목록 ───────────────────────────────────────────────
    if (req.method === "GET") {
      const q = req.query || {};
      const all = admin && q.all === "1";
      const jobs = (await H.allSchedules())
        .filter(j => all || String(j.by || "").toLowerCase() === meEmail)
        .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
      res.status(200).json({ timezones: TZ_PRESETS, jobs: jobs.map(publicJob) });
      return;
    }

    // ─── DELETE: 취소 ────────────────────────────────────────────
    if (req.method === "DELETE") {
      const id = String((req.query && req.query.id) || "").trim();
      if (!id) { res.status(400).json({ error: "id 가 필요합니다" }); return; }
      const job = (await H.allSchedules()).find(j => String(j.id) === id);
      if (!job) { res.status(404).json({ error: "그 예약이 없습니다" }); return; }
      // 남의 예약은 관리자만 취소할 수 있다
      if (String(job.by || "").toLowerCase() !== meEmail && !admin) {
        res.status(403).json({ error: "남의 예약은 취소할 수 없습니다" });
        return;
      }
      if (job.status !== "pending") { res.status(409).json({ error: "이미 처리된 예약입니다 (" + job.status + ")" }); return; }
      await H.deleteSchedule(id);
      res.status(200).json({ canceled: true, id });
      return;
    }

    if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }

    // ─── POST { action:"run" }: 지금 바로 처리 ───────────────────
    // 크론(15분)이 아직 안 돌았거나 흔들릴 때, 본인이 기한 도래한 자기 예약을 즉시 보낸다.
    // 미래 예약은 건드리지 않는다(processDue 가 기한 도래분만 보냄). 남의 예약도 안 건드린다.
    {
      const peek = readBody(req);
      if (peek && peek.action === "run") {
        let summary = null;
        try { summary = await Sch.processDue({ onlyBy: meEmail, budgetMs: 25000 }); }
        catch (e) { res.status(502).json({ error: "예약 처리 중 오류: " + String((e && e.message) || e) }); return; }
        const jobs = (await H.allSchedules())
          .filter(j => String(j.by || "").toLowerCase() === meEmail)
          .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
        res.status(200).json({ ran: true, summary, jobs: jobs.map(publicJob) });
        return;
      }
    }

    // ─── POST: 예약 생성 ─────────────────────────────────────────
    const body = readBody(req);
    const campaign = body.campaign || {};
    const recipients = (Array.isArray(body.recipients) ? body.recipients : [])
      .filter(r => r && EMAIL_RE.test(String(r.to || "").trim()));
    const when = body.when || {};
    // 강제 발송은 즉시 발송과 같은 규칙 — 관리자만
    const force = Boolean(body.force) && admin;

    if (!recipients.length) { res.status(400).json({ error: "예약할 수신자가 없습니다" }); return; }
    if (recipients.length > MAX_RECIPIENTS) {
      res.status(400).json({ error: `예약 하나당 최대 ${MAX_RECIPIENTS}명까지 (요청: ${recipients.length}명)` });
      return;
    }

    const tz = String(when.tz || "").trim();
    if (!tz || !validTz(tz)) { res.status(400).json({ error: "시간대(tz)가 올바르지 않습니다: " + tz }); return; }

    const at = utcFromZoned(when.date, when.time, tz);
    if (!isFinite(at)) { res.status(400).json({ error: "날짜/시각 형식이 올바르지 않습니다 (YYYY-MM-DD, HH:MM)" }); return; }
    if (at < Date.now() + 60e3) { res.status(400).json({ error: "예약 시각이 이미 지났거나 너무 가깝습니다 — 현지 시간 기준으로 다시 확인하세요" }); return; }
    if (at > Date.now() + MAX_AHEAD_DAYS * 86400e3) {
      res.status(400).json({ error: `예약은 ${MAX_AHEAD_DAYS}일 안에서만 걸 수 있습니다` });
      return;
    }

    // 캠페인 스냅샷 크기 상한 — 첨부 이미지가 아주 크면 저장소 요청 한도를 넘는다
    const snapshot = JSON.stringify(campaign);
    if (snapshot.length > MAX_CAMPAIGN_BYTES) {
      res.status(400).json({
        error: "캠페인 내용(첨부 이미지 포함)이 너무 커서 예약할 수 없습니다. 제품 이미지를 URL 방식으로 바꾸거나 더 작은 파일을 쓰세요."
      });
      return;
    }

    const label = (TZ_PRESETS.find(p => p.tz === tz) || {}).label || tz;
    const job = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      at: new Date(at).toISOString(),
      tz, local: `${when.date} ${when.time} · ${label}`,
      by: meEmail, byName: me.name || meEmail.split("@")[0],
      campaign, recipients, force,
      status: "pending", createdAt: new Date().toISOString()
    };
    await H.saveSchedule(job);

    res.status(200).json({ scheduled: true, job: publicJob(job) });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
