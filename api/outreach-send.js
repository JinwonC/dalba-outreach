// Vercel Serverless Function — 배포 경로: /api/outreach-send
//
// 크리에이터 아웃리치 메일을 **네이버웍스 SMTP** 로 실제 발송한다.
// 템플릿은 루트의 email-template.js 한 곳에서만 만든다(미리보기 = 실제 발송본 보장).
//
//   GET  /api/outreach-send        → 설정 상태 조회 (모드·SMTP·허용 도메인·로그인한 사람)
//   POST /api/outreach-send        → 단건/대량 발송
//
// ─── 발신 계정을 정하는 두 가지 방식 ──────────────────────────────
// 1) 로그인 방식 (권장) — 환경변수 NW_ACCOUNTS 에 직원 목록을 등록한 경우.
//    로그인한 직원의 계정을 서버가 꺼내 쓴다. 앱 비밀번호가 브라우저로 나가지 않고,
//    요청 본문이 다른 주소를 지정해도 무시되므로 남의 이름으로 보낼 수 없다.
//    직원 등록·세션 처리는 ../auth.js 참고.
// 2) BYO 방식 — 직원 목록을 등록하지 않은 배포. 담당자가 자기 네이버웍스 계정과
//    앱 비밀번호를 브라우저에 넣고, 그 자격증명이 요청마다 함께 온다.
//    이때는 회사 도메인인지 검사한다. 자격증명은 서버에 저장하지 않는다.
//
// ─── 오픈 릴레이 방지 ─────────────────────────────────────────────
//   1) SMTP 호스트/포트는 **서버에서 고정** — 요청으로 바꿀 수 없다.
//   2) BYO 방식의 발신 주소는 ALLOWED_DOMAINS 에 속한 회사 도메인만 허용.
//
// ─── 네이버웍스 준비 (계정 1개당 1회) ────────────────────────────
//   1) 관리자센터에서 POP3/IMAP/SMTP 사용 **허용** (조직 관리자가 1회)
//   2) [설정 > 보안 > 외부 앱 비밀번호] 에서 앱 비밀번호 발급
//      ※ 로그인 비밀번호로는 SMTP 인증이 안 된다.
//
// ─── 환경변수 ────────────────────────────────────────────────────
//   NW_ACCOUNTS        직원 목록 (설정하면 로그인 방식). 형식은 ../auth.js 주석 참고
//   NW_DOMAIN          발신 허용 도메인. 콤마로 여러 개. 기본 "dalbausa.com,dalba.com"
//   NW_SMTP_HOST       기본 smtp.worksmobile.com
//   NW_SMTP_PORT       기본 465 (SSL). 587 이면 STARTTLS 로 자동 전환
//   NW_BCC             발송 사본을 받을 주소 — 팀 공용 발송 이력 보관용
//   DASHBOARD_PASSWORD BYO 방식일 때의 공용 비밀번호. 로그인 방식에서는 쓰이지 않는다

const nodemailer = require("nodemailer");
const T = require("../email-template.js");
const A = require("../auth.js");

// 서버 고정값 — 클라이언트가 바꿀 수 없다
const SMTP_HOST = process.env.NW_SMTP_HOST || "smtp.worksmobile.com";
const SMTP_PORT = Number(process.env.NW_SMTP_PORT || 465);

const ALLOWED_DOMAINS = (process.env.NW_DOMAIN || "dalbausa.com,dalba.com")
  .split(",").map(s => s.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);

const MAX_PER_REQUEST = 25;   // Vercel 60s 안에서 안전한 배치 크기 (프론트가 청크로 쪼개 호출)

// 연속 발송 간격 — 네이버웍스는 **분당 60회**를 넘기면 최대 1분간 차단한다.
// 1100ms 면 분당 약 54회로 한도 아래에 머문다. 25명 배치가 약 26초 걸려 60초 제한 안에도 든다.
const SEND_GAP_MS = 1100;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function domainOf(email) { return String(email || "").toLowerCase().split("@")[1] || ""; }
function domainAllowed(email) { return ALLOWED_DOMAINS.includes(domainOf(email)); }

// 헤더 인젝션 방지: 표시 이름/주소에 개행이 섞이면 제거
function cleanHeader(s) { return String(s == null ? "" : s).replace(/[\r\n]+/g, " ").trim(); }

// 이번 요청에 쓸 발신 계정 확정
//
// 두 가지 방식이 있고, 직원 계정(NW_ACCOUNTS)이 설정돼 있으면 그쪽이 우선이다.
//   1) 로그인 방식 — 로그인한 직원의 계정을 서버에서 꺼내 쓴다.
//      앱 비밀번호가 브라우저로 나가지 않고, 남의 주소로 보낼 수도 없다.
//   2) BYO 방식  — 직원 계정을 등록하지 않은 배포용. 브라우저가 보낸 자격증명을 쓰고,
//      대신 회사 도메인인지 검사한다.
function resolveAccount(req, body) {
  if (A.enabled()) {
    const u = A.currentUser(req);
    if (!u) return { error: "로그인이 필요합니다", unauthorized: true };
    return {
      account: {
        name: cleanHeader(u.name) || u.email.split("@")[0],
        email: u.email,
        password: u.appPassword,
        title: cleanHeader(u.title || "")
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
      name: cleanHeader(a.name) || email.split("@")[0],
      email,
      password: String(a.password),
      title: cleanHeader(a.title || "")
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
        smtp: { host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465 },
        allowedDomains: ALLOWED_DOMAINS,
        maxPerRequest: MAX_PER_REQUEST,
        protected: Boolean(PW) || A.enabled(),
        bcc: Boolean(process.env.NW_BCC),
        me: A.publicUser(me)     // 로그인 상태면 누구인지, 아니면 null
      });
      return;
    }

    if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }

    const body = readBody(req);
    const campaign = body.campaign || {};
    const recipients = Array.isArray(body.recipients) ? body.recipients : [];
    const dryRun = Boolean(body.dryRun);

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

    // 수신자별 데이터: 캠페인 공통값 + 수신자 개별값(개별값 우선)
    // 서명/발신자는 **인증 계정으로 강제** — 네이버웍스는 인증 계정 외 From 을 허용하지 않는다.
    const compose = r => Object.assign({}, campaign, r, {
      senderName: account ? account.name : (campaign.senderName || ""),
      senderEmail: account ? account.email : (campaign.senderEmail || ""),
      senderTitle: (account && account.title) || campaign.senderTitle || ""
    });

    // ─── dryRun: 발송 없이 렌더 결과만 확인 ──────────────────────
    if (dryRun) {
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

    // ─── SMTP 연결 ───────────────────────────────────────────────
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,          // 465=SSL 즉시 암호화 / 587=STARTTLS
      requireTLS: SMTP_PORT !== 465,
      auth: { user: account.email, pass: account.password },
      pool: true,
      maxConnections: 1,                  // 순차 발송 — 유량 제한 회피
      connectionTimeout: 20000,
      greetingTimeout: 20000,
      socketTimeout: 25000
    });

    try {
      await transporter.verify();
    } catch (e) {
      transporter.close();
      res.status(502).json({
        error: "네이버웍스 SMTP 인증/연결 실패: " + String((e && e.message) || e),
        hint: "① 관리자센터에서 IMAP/POP3·SMTP 사용이 허용됐는지 " +
              "② 로그인 비밀번호가 아니라 '설정 > 보안 > 외부 앱 비밀번호'에서 발급한 값을 넣었는지 " +
              "③ 계정이 " + account.email + " 가 맞는지 확인하세요."
      });
      return;
    }

    // ─── 순차 발송 ───────────────────────────────────────────────
    // 간격은 **발송에 걸린 시간을 뺀 나머지**만 쉰다. 발송마다 SMTP 왕복이 1초 가까이
    // 걸릴 수 있는데 거기에 고정 대기를 더하면 25명 배치가 Vercel 60초 제한을 넘긴다.
    const results = [];
    let lastAt = 0;
    for (let i = 0; i < recipients.length; i++) {
      const d = compose(recipients[i]);
      const to = cleanHeader(d.to);

      const errs = T.validate(d);
      if (errs.length) {
        // 보내지 않았으니 간격도 소비하지 않는다
        results.push({ to, ok: false, error: errs.join(" / ") });
        continue;
      }

      if (lastAt) {
        const wait = SEND_GAP_MS - (Date.now() - lastAt);
        if (wait > 0) await sleep(wait);
      }
      lastAt = Date.now();

      try {
        const built = T.build(d);
        const toName = cleanHeader(d.creatorName || "");
        const info = await transporter.sendMail({
          from: { name: cleanHeader(account.name), address: account.email },  // 인증 계정 고정
          to: toName ? { name: toName, address: to } : to,
          replyTo: account.email,
          bcc: process.env.NW_BCC || undefined,   // 발송 이력 보관용 사본
          subject: cleanHeader(built.subject),
          text: built.text,
          html: built.html
        });
        results.push({ to, ok: true, messageId: info.messageId, subject: built.subject });
      } catch (e) {
        results.push({ to, ok: false, error: String((e && e.message) || e) });
      }
    }

    transporter.close();

    const sent = results.filter(r => r.ok).length;
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      sentAt: new Date().toISOString(),
      sender: { name: account.name, email: account.email },
      totals: { requested: recipients.length, sent, failed: recipients.length - sent },
      results
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
