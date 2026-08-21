// Vercel Serverless Function — 배포 경로: /api/outreach-send
//
// 크리에이터 아웃리치 메일을 **네이버웍스 SMTP** 로 실제 발송한다.
// 템플릿은 루트의 email-template.js 한 곳에서만 만든다(미리보기 = 실제 발송본 보장).
// 실제 발송 로직은 ../send-core.js 에 있다 — 예약 발송(scheduled.js)과 같은 코드를 쓴다.
//
//   GET  /api/outreach-send        → 설정 상태 조회 (모드·SMTP·허용 도메인·로그인한 사람)
//   POST /api/outreach-send        → 단건/대량 발송
//
// ─── 발신 계정을 정하는 두 가지 방식 ──────────────────────────────
// 1) 로그인 방식 (권장) — 환경변수 NW_ACCOUNTS 에 직원 목록을 등록한 경우.
//    로그인한 직원의 계정을 서버가 꺼내 쓴다. 앱 비밀번호가 브라우저로 나가지 않고,
//    요청 본문이 다른 주소를 지정해도 무시되므로 남의 이름으로 보낼 수 없다.
// 2) BYO 방식 — 직원 목록을 등록하지 않은 배포. 담당자가 자기 네이버웍스 계정과
//    앱 비밀번호를 브라우저에 넣고, 그 자격증명이 요청마다 함께 온다.
//    이때는 회사 도메인인지 검사한다. 자격증명은 서버에 저장하지 않는다.
//
// ─── 오픈 릴레이 방지 ─────────────────────────────────────────────
//   1) SMTP 호스트/포트는 **서버에서 고정** — 요청으로 바꿀 수 없다.
//   2) BYO 방식의 발신 주소는 ALLOWED_DOMAINS 에 속한 회사 도메인만 허용.
//
// ─── 환경변수 ────────────────────────────────────────────────────
//   NW_ACCOUNTS        직원 목록 (설정하면 로그인 방식). 형식은 ../auth.js 주석 참고
//   NW_DOMAIN          발신 허용 도메인. 콤마로 여러 개. 기본 "dalbausa.com,dalba.com"
//   NW_SMTP_HOST       기본 smtp.worksmobile.com
//   NW_SMTP_PORT       기본 465 (SSL). 587 이면 STARTTLS 로 자동 전환
//   NW_BCC             발송 사본을 받을 주소 — 팀 공용 발송 이력 보관용
//   DASHBOARD_PASSWORD BYO 방식일 때의 공용 비밀번호. 로그인 방식에서는 쓰이지 않는다

const T = require("../email-template.js");
const A = require("../auth.js");
const H = require("../history.js");
const C = require("../send-core.js");

const ALLOWED_DOMAINS = (process.env.NW_DOMAIN || "dalbausa.com,dalba.com")
  .split(",").map(s => s.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);

const MAX_PER_REQUEST = 25;   // Vercel 60s 안에서 안전한 배치 크기 (프론트가 청크로 쪼개 호출)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function domainOf(email) { return String(email || "").toLowerCase().split("@")[1] || ""; }
function domainAllowed(email) { return ALLOWED_DOMAINS.includes(domainOf(email)); }

// 관리자 화면 버튼 노출 여부 판단용. 실제 권한 검사는 api/admin.js 가 다시 한다.
const isAdmin = A.isAdmin;

// 이번 요청에 쓸 발신 계정 확정 — 로그인 방식이 우선, 아니면 BYO(도메인 검사).
function resolveAccount(req, body) {
  if (A.enabled()) {
    const u = A.currentUser(req);
    if (!u) return { error: "로그인이 필요합니다", unauthorized: true };
    return {
      account: {
        name: C.cleanHeader(u.name) || u.email.split("@")[0],
        email: u.email,
        password: u.appPassword,
        title: C.cleanHeader(u.title || "")
      }
    };
  }

  const a = body.auth || {};
  const email = String(a.email || "").trim().toLowerCase();
  if (!email || !a.password) {
    return { error: "발신 계정이 없습니다. 화면 오른쪽 위 [내 발신 계정] 에서 네이버웍스 주소와 외부 앱 비밀번호를 등록하세요." };
  }
  if (!EMAIL_RE.test(email)) return { error: "발신 이메일 형식이 올바르지 않습니다: " + email };
  if (!domainAllowed(email)) {
    return { error: `발신 주소는 ${ALLOWED_DOMAINS.map(d => "@" + d).join(" 또는 ")} 만 허용됩니다 (요청: ${email})` };
  }
  return {
    account: {
      name: C.cleanHeader(a.name) || email.split("@")[0],
      email,
      password: String(a.password),
      title: C.cleanHeader(a.title || "")
    }
  };
}

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch (_) { return {}; } }
  return b;
}

module.exports = async (req, res) => {
  try {
    // ─── 접근 보호 ───────────────────────────────────────────────
    // 이 엔드포인트는 **실제로 메일을 보낸다**.
    // 직원 계정을 쓰는 배포에서는 로그인 세션이 그 역할을 하므로 공용 비밀번호를 요구하지 않는다.
    const PW = A.enabled() ? "" : process.env.DASHBOARD_PASSWORD;
    if (PW) {
      const given = req.headers["x-dashboard-password"] || (req.query && req.query.pw) || "";
      if (given !== PW) { res.status(401).json({ error: "unauthorized" }); return; }
    }

    // ─── GET: 설정 상태 (비밀번호류는 절대 반환하지 않는다) ───────
    if (req.method === "GET") {
      res.setHeader("Cache-Control", "no-store");
      const me = A.enabled() ? A.currentUser(req) : null;
      res.status(200).json({
        mode: A.enabled() ? "accounts" : "byo",
        smtp: { host: C.SMTP_HOST, port: C.SMTP_PORT, secure: C.SMTP_PORT === 465 },
        allowedDomains: ALLOWED_DOMAINS,
        maxPerRequest: MAX_PER_REQUEST,
        protected: Boolean(PW) || A.enabled(),
        bcc: Boolean(process.env.NW_BCC),
        history: { enabled: H.enabled(), windowDays: H.WINDOW_DAYS },
        admin: isAdmin(me),          // 관리자 화면 버튼을 띄울지
        // 미리보기도 외부 요청 없이 로고를 그리도록 data URL 로 준다 (없으면 URL 폴백)
        logoUrl: C.logoDataUrl() || C.logoUrl(),
        me: A.publicUser(me)     // 로그인 상태면 누구인지, 아니면 null
      });
      return;
    }

    if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }

    const body = readBody(req);
    const campaign = body.campaign || {};
    const recipients = Array.isArray(body.recipients) ? body.recipients : [];
    const dryRun = Boolean(body.dryRun);
    // 강제 발송(중복 무시)은 **관리자만** 할 수 있다. 관리자가 아니면 요청에 force 가 실려
    // 와도 무시한다 — 화면에서 체크박스를 숨기는 것만으로는 보호가 아니다(서버가 막아야 한다).
    const me = A.enabled() ? A.currentUser(req) : null;
    const force = Boolean(body.force) && isAdmin(me);

    if (!recipients.length) { res.status(400).json({ error: "recipients 가 비어 있습니다" }); return; }
    if (recipients.length > MAX_PER_REQUEST) {
      res.status(400).json({ error: `한 요청당 최대 ${MAX_PER_REQUEST}명까지 (요청: ${recipients.length}명)` });
      return;
    }

    // ─── 발신 계정 확정 ──────────────────────────────────────────
    const resolved = resolveAccount(req, body);
    if (resolved.unauthorized) { res.status(401).json({ error: resolved.error }); return; }
    if (resolved.error && !dryRun) { res.status(400).json({ error: resolved.error }); return; }
    const account = resolved.account || null;

    // ─── dryRun: 발송 없이 렌더 결과만 확인 ──────────────────────
    // 미리보기는 인라인 첨부(cid) 대신 data URL 로 그린다 — 브라우저에서 바로 보여야 하므로.
    if (dryRun) {
      const inlineImg = C.parseDataImage(campaign.productImageData);
      const compose = C.composerFor(account, campaign, { inlineImg, logoAtt: null, real: false });
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({
        dryRun: true,
        sender: account ? { name: account.name, email: account.email } : null,
        warning: resolved.error || undefined,
        results: recipients.map(r => {
          const d = compose(r);
          const errs = T.validate(d);
          const built = T.build(d);
          return { to: d.to, ok: !errs.length, errors: errs, subject: built.subject, html: built.html };
        })
      });
      return;
    }

    // ─── 실제 발송 — 공용 발송 코어 ──────────────────────────────
    const out = await C.sendBatch({ account, campaign, recipients, force });
    if (out.smtpError) {
      res.status(502).json({ error: out.smtpError, hint: out.hint });
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      sentAt: new Date().toISOString(),
      sender: { name: account.name, email: account.email },
      totals: { requested: recipients.length, sent: out.sent, held: out.held, failed: recipients.length - out.sent - out.held },
      results: out.results
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
