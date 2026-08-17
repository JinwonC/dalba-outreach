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
//
// ─── 중복 발송 차단 ──────────────────────────────────────────────
// 공용 이력 저장소가 설정돼 있으면(../history.js) 발송 직전에 수신자별로 자리를 잡고,
// 이미 보낸 주소·핸들이면 그 건만 보류한다. body.force 가 true 면 덮어쓰고 보낸다.
// 저장소가 없으면 이 검사는 통째로 건너뛴다 — 안전장치이지 발송의 전제가 아니다.

const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const T = require("../email-template.js");
const A = require("../auth.js");
const H = require("../history.js");

// 서버 고정값 — 클라이언트가 바꿀 수 없다
const SMTP_HOST = process.env.NW_SMTP_HOST || "smtp.worksmobile.com";
const SMTP_PORT = Number(process.env.NW_SMTP_PORT || 465);

const ALLOWED_DOMAINS = (process.env.NW_DOMAIN || "dalbausa.com,dalba.com")
  .split(",").map(s => s.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);

// 메일 헤더 로고 이미지 주소.
//  1) LOGO_URL 을 직접 넣었으면 그걸 쓴다 (커스텀 도메인·외부 CDN 등).
//  2) 아니면 레포에 올린 logo-black.png 를 Vercel 배포 도메인에서 불러온다.
//     VERCEL_PROJECT_PRODUCTION_URL 은 배포마다 바뀌지 않는 프로덕션 도메인이라
//     발송 메일이 항상 같은 주소를 가리킨다.
//  3) 둘 다 없으면 빈 값 → 템플릿이 텍스트 워드마크로 그린다 (로컬 개발 등).
function logoUrl() {
  if (process.env.LOGO_URL) return process.env.LOGO_URL;
  const host = (process.env.VERCEL_PROJECT_PRODUCTION_URL || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return host ? "https://" + host + "/logo-black.png" : "";
}

// ─── 로고를 메일에 인라인으로 박는다 ──────────────────────────────
// 외부 URL 로 불러오면 배포 보호·리다이렉트·전파 지연 등으로 그 요청이 실패해
// 로고가 깨져 보일 때가 있다. 제품 이미지처럼 파일을 메일 안에 담으면(cid) 외부 요청이
// 아예 없어 절대 깨지지 않는다. 파일은 레포 루트의 logo-black.png 다.
// LOGO_URL 을 명시적으로 지정한 배포는 그 뜻을 존중해 인라인을 쓰지 않는다.
const LOGO_CID = "dalbalogo@dalba";
let logoBuf;   // undefined=아직 안 읽음, null=없음, Buffer=성공
function logoBuffer() {
  if (logoBuf !== undefined) return logoBuf;
  if (process.env.LOGO_URL) { logoBuf = null; return logoBuf; }   // 외부 로고를 쓰겠다고 명시함
  try { logoBuf = fs.readFileSync(path.join(__dirname, "..", "logo-black.png")); }
  catch (_) { logoBuf = null; }
  return logoBuf;
}
function logoDataUrl() {
  const b = logoBuffer();
  return b ? "data:image/png;base64," + b.toString("base64") : "";
}
function logoAttachment() {
  const b = logoBuffer();
  return b ? { filename: "logo.png", content: b, contentType: "image/png", cid: LOGO_CID, contentDisposition: "inline" } : null;
}

// 관리자 화면(/admin.html)을 볼 수 있는 사람. 여기서는 버튼 노출 여부만 판단하고,
// 실제 권한 검사는 api/admin.js 가 다시 한다 — 화면을 숨기는 건 보호가 아니다.
// 판정은 auth.js 한 곳에서만 (콤마·세미콜론·공백·줄바꿈 구분 모두 허용)
const isAdmin = A.isAdmin;

// 업로드한 제품 이미지(data URL)를 메일 인라인 첨부로 바꾼다.
// 상품이 TikTok Shop 목록에 없어 이미지 URL 이 없을 때, 링크 대신 파일을 그대로 붙인다.
// 콤마 뒤가 base64 문자뿐인지 전체를 검사하고 5MB 로 상한을 둔다.
const INLINE_IMG_CID = "productimg@dalba";
function parseDataImage(s) {
  // m[1]=전체 MIME(image/jpeg), m[2]=하위타입(jpeg), m[3]=base64
  const m = /^data:(image\/(png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(s == null ? "" : s).trim());
  if (!m) return null;
  const buffer = Buffer.from(m[3].replace(/\s+/g, ""), "base64");
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) return null;
  const sub = m[2].toLowerCase();
  const ext = (sub === "jpg" || sub === "jpeg") ? "jpeg" : sub;
  return { buffer, contentType: m[1].toLowerCase(), ext };
}

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

// 보류 사유는 담당자가 바로 판단할 수 있게 "누가 언제" 를 담는다
function heldReason(prior) {
  if (!prior) return "이미 발송된 주소입니다 (보류)";
  const who = prior.byName || prior.by || "다른 담당자";
  const when = prior.at ? String(prior.at).slice(0, 10) : "";
  return `이미 ${who} 님이${when ? " " + when + " 에" : ""} 발송했습니다 (보류)` +
         (prior.campaign ? ` — ${prior.campaign}` : "");
}

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
        history: { enabled: H.enabled(), windowDays: H.WINDOW_DAYS },
        admin: isAdmin(me),          // 관리자 화면 버튼을 띄울지
        // 미리보기도 외부 요청 없이 로고를 그리도록 data URL 로 준다 (없으면 URL 폴백)
        logoUrl: logoDataUrl() || logoUrl(),
        me: A.publicUser(me)     // 로그인 상태면 누구인지, 아니면 null
      });
      return;
    }

    if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }

    const body = readBody(req);
    const campaign = body.campaign || {};
    const recipients = Array.isArray(body.recipients) ? body.recipients : [];
    const dryRun = Boolean(body.dryRun);
    const force = Boolean(body.force);   // 이미 보낸 사람도 보내겠다고 담당자가 명시한 경우

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

    // 업로드한 제품 이미지가 있으면 한 번만 디코드해 둔다 (모든 수신자에게 같은 이미지)
    const inlineImg = parseDataImage(campaign.productImageData);
    // 로고 파일 — 실제 발송에서는 인라인(cid) 첨부, 미리보기(dryRun)에서는 data URL
    const logoAtt = dryRun ? null : logoAttachment();
    // 첨부는 수신자와 무관하게 같으므로 한 번만 만든다 (로고 + 업로드한 제품 이미지)
    const attachments = [];
    if (logoAtt) attachments.push(logoAtt);
    if (inlineImg) attachments.push({
      filename: "product." + inlineImg.ext,
      content: inlineImg.buffer,
      contentType: inlineImg.contentType,
      cid: INLINE_IMG_CID,               // html 의 src="cid:productimg@dalba" 와 맞물린다
      contentDisposition: "inline"
    });

    // 수신자별 데이터: 캠페인 공통값 + 수신자 개별값(개별값 우선)
    // 서명/발신자는 **인증 계정으로 강제** — 네이버웍스는 인증 계정 외 From 을 허용하지 않는다.
    const compose = r => Object.assign({}, campaign, r, {
      senderName: account ? account.name : (campaign.senderName || ""),
      senderEmail: account ? account.email : (campaign.senderEmail || ""),
      senderTitle: (account && account.title) || campaign.senderTitle || "",
      // 로고: 실제 발송은 인라인 첨부(cid), 미리보기는 data URL, 둘 다 없으면 외부 URL/텍스트
      logoUrl: logoAtt ? ("cid:" + LOGO_CID) : (logoDataUrl() || campaign.logoUrl || logoUrl()),
      // 실제 발송에서는 업로드 이미지를 cid 로 참조한다(첨부는 아래에서 붙인다).
      // dryRun 은 cid 를 안 넣어 템플릿이 data URL 을 그대로 그린다(미리보기).
      productImageCid: (inlineImg && !dryRun) ? INLINE_IMG_CID : ""
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

      // ─── 중복 발송 차단 ────────────────────────────────────────
      // 화면에서 미리 확인했더라도 여기서 다시 잡는다. 미리보기와 발송 사이에
      // 다른 담당자가 먼저 보냈을 수 있고, 그 경합은 여기서만 막을 수 있다.
      let reserved = false;
      try {
        const rv = await H.reserve(d, {
          by: account.email, byName: account.name, campaign: d.campaignTitle || ""
        }, force);
        if (!rv.ok) {
          results.push({ to, ok: false, held: true, prior: rv.prior || null, error: heldReason(rv.prior) });
          // 누가 누구에게 보내려다 막혔는지 — 관리자 화면에서 명단 겹침을 보는 근거
          H.logBlocked({
            to, handle: d.handle || "", name: d.creatorName || "",
            at: new Date().toISOString(),
            by: account.email, byName: account.name,
            campaign: d.campaignTitle || "",
            prior: rv.prior || null
          });
          continue;
        }
        reserved = !rv.skipped;
      } catch (e) {
        // 저장소가 죽으면 이미 보낸 사람인지 알 수 없다. 이럴 때 그냥 보내면
        // 중복 발송이 나가므로 기본은 **보내지 않는다**. 다만 담당자가 [강제 발송] 을
        // 켰다면 중복 위험을 감수하겠다고 밝힌 것이므로 그대로 진행한다 —
        // 저장소 장애 때 아웃리치가 통째로 멈추는 걸 막는 탈출구.
        if (!force) {
          results.push({
            to, ok: false,
            error: "이력 확인 실패로 보내지 않았습니다 (중복 방지). 잠시 후 다시 시도하거나, " +
                   "그래도 보내려면 [강제 발송] 을 켜세요 — " + String((e && e.message) || e)
          });
          continue;
        }
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
          html: built.html,
          attachments: attachments.length ? attachments : undefined
        });
        results.push({ to, ok: true, messageId: info.messageId, subject: built.subject });
        H.log({
          to, handle: d.handle || "", name: d.creatorName || "",
          at: new Date().toISOString(), by: account.email, byName: account.name,
          campaign: d.campaignTitle || "", forced: force || undefined
        });
      } catch (e) {
        // 못 보냈으면 잡아둔 자리를 반납한다 — 실패한 주소가 계속 막히면 안 된다
        if (reserved) { try { await H.release(d); } catch (_) {} }
        results.push({ to, ok: false, error: String((e && e.message) || e) });
      }
    }

    transporter.close();

    const sent = results.filter(r => r.ok).length;
    const held = results.filter(r => r.held).length;
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      sentAt: new Date().toISOString(),
      sender: { name: account.name, email: account.email },
      totals: { requested: recipients.length, sent, held, failed: recipients.length - sent - held },
      results
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
