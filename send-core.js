// 실제 발송 한 배치의 공통 로직.
//
// 즉시 발송(/api/outreach-send)과 예약 발송(scheduled.js — 크론이 처리)이 **같은 코드**로
// 보낸다. 두 곳에 발송 로직을 따로 두면 중복 차단·리마인드 예약·첨부 처리가 조용히 갈린다.
//
// 여기 있는 것: SMTP 연결, 로고·제품이미지 인라인 첨부, 수신자별 compose, 중복 차단(reserve),
//              발송·이력 기록·리마인드 예약, 유량 제한 간격.
// 여기 없는 것: 인증·권한(누가 보내는가) — 그건 호출하는 쪽(핸들러/크론)이 정한다.

const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const T = require("./email-template.js");
const H = require("./history.js");

// 서버 고정값 — 클라이언트가 바꿀 수 없다
const SMTP_HOST = process.env.NW_SMTP_HOST || "smtp.worksmobile.com";
const SMTP_PORT = Number(process.env.NW_SMTP_PORT || 465);

// 연속 발송 간격 — 네이버웍스는 분당 60회를 넘기면 최대 1분간 차단한다.
const SEND_GAP_MS = 1100;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── 로고 인라인 첨부 ─────────────────────────────────────────────
// 외부 URL 은 배포 보호 등으로 깨질 수 있어 파일을 메일 안에 담는다(cid).
// LOGO_URL 을 명시한 배포는 그 뜻을 존중해 인라인을 쓰지 않는다.
const LOGO_CID = "dalbalogo@dalba";
let logoBuf;   // undefined=아직 안 읽음, null=없음, Buffer=성공
function logoBuffer() {
  if (logoBuf !== undefined) return logoBuf;
  if (process.env.LOGO_URL) { logoBuf = null; return logoBuf; }
  try { logoBuf = fs.readFileSync(path.join(__dirname, "logo-black.png")); }
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
function logoUrl() {
  if (process.env.LOGO_URL) return process.env.LOGO_URL;
  const host = (process.env.VERCEL_PROJECT_PRODUCTION_URL || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return host ? "https://" + host + "/logo-black.png" : "";
}

// 업로드한 제품 이미지(data URL) → 인라인 첨부. 5MB 상한, base64 전체 검사.
const INLINE_IMG_CID = "productimg@dalba";
function parseDataImage(s) {
  const m = /^data:(image\/(png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(s == null ? "" : s).trim());
  if (!m) return null;
  const buffer = Buffer.from(m[3].replace(/\s+/g, ""), "base64");
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) return null;
  const sub = m[2].toLowerCase();
  const ext = (sub === "jpg" || sub === "jpeg") ? "jpeg" : sub;
  return { buffer, contentType: m[1].toLowerCase(), ext };
}

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

// 캠페인의 자동 리마인드(팔로업) 설정을 해석한다.
// 회차별 문구를 채운 만큼(1차부터 연속으로) 보낸다. 하나도 안 적었으면 기본 문구로 maxCount 번.
function parseFollowup(campaign) {
  const rem = (campaign && campaign.followup) || {};
  const notes = (Array.isArray(rem.messages) ? rem.messages : [])
    .map(s => String(s == null ? "" : s).trim());
  let filled = 0;
  for (const m of notes) { if (m) filled++; else break; }
  const maxCount = filled > 0 ? filled : Math.max(1, Math.min(Number(rem.maxCount) || 2, 10));
  return {
    enabled: Boolean(rem.enabled),
    intervalDays: Math.max(1, Math.min(Number(rem.intervalDays) || 3, 60)),
    maxCount,
    notes: notes.slice(0, maxCount)
  };
}

// 수신자별 데이터 compose 함수를 만든다. 서명/발신자는 인증 계정으로 강제하고,
// 실제 발송이면 로고·제품이미지를 cid 로 참조하게 한다.
function composerFor(account, campaign, opts) {
  const o = opts || {};
  const inlineImg = o.inlineImg;
  const useLogoCid = Boolean(o.logoAtt);
  return r => Object.assign({}, campaign, r, {
    senderName: account ? account.name : (campaign.senderName || ""),
    senderEmail: account ? account.email : (campaign.senderEmail || ""),
    senderTitle: (account && account.title) || campaign.senderTitle || "",
    logoUrl: useLogoCid ? ("cid:" + LOGO_CID) : (logoDataUrl() || campaign.logoUrl || logoUrl()),
    productImageCid: (inlineImg && o.real) ? INLINE_IMG_CID : ""
  });
}

// ─── 한 배치 발송 ─────────────────────────────────────────────────
// account: { name, email, password(앱 비밀번호), title }
// 반환: { results:[...], sent, held, failed }  /  SMTP 인증 실패면 { smtpError, hint }
// budgetMs 가 있으면 그 예산 안에서만 보내고, 못 보낸 수신자는 leftover 로 돌려준다
// (예약 발송을 크론 제한시간 안에서 나눠 보내기 위한 것 — 즉시 발송은 예산 없이 부른다).
async function sendBatch(opts) {
  const account = opts.account;
  const campaign = opts.campaign || {};
  const recipients = Array.isArray(opts.recipients) ? opts.recipients : [];
  const force = Boolean(opts.force);
  const deadline = opts.budgetMs ? Date.now() + Number(opts.budgetMs) : 0;

  const inlineImg = parseDataImage(campaign.productImageData);
  const ccList = T.parseList(campaign.cc);
  const followup = parseFollowup(campaign);
  const remindOn = followup.enabled && H.enabled();

  const logoAtt = logoAttachment();
  const attachments = [];
  if (logoAtt) attachments.push(logoAtt);
  if (inlineImg) attachments.push({
    filename: "product." + inlineImg.ext,
    content: inlineImg.buffer,
    contentType: inlineImg.contentType,
    cid: INLINE_IMG_CID,
    contentDisposition: "inline"
  });

  const compose = composerFor(account, campaign, { inlineImg, logoAtt, real: true });

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT,
    secure: SMTP_PORT === 465, requireTLS: SMTP_PORT !== 465,
    auth: { user: account.email, pass: account.password },
    pool: true, maxConnections: 1,
    connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 25000
  });

  try {
    await transporter.verify();
  } catch (e) {
    transporter.close();
    return {
      smtpError: "네이버웍스 SMTP 인증/연결 실패: " + String((e && e.message) || e),
      hint: "① 관리자센터에서 IMAP/POP3·SMTP 사용이 허용됐는지 " +
            "② 로그인 비밀번호가 아니라 '설정 > 보안 > 외부 앱 비밀번호'에서 발급한 값을 넣었는지 " +
            "③ 계정이 " + account.email + " 가 맞는지 확인하세요."
    };
  }

  const results = [];
  const leftover = [];
  let lastAt = 0;

  for (let i = 0; i < recipients.length; i++) {
    // 예산이 다 됐으면 남은 수신자는 다음 실행(크론)이 이어받는다
    if (deadline && Date.now() > deadline) { leftover.push(...recipients.slice(i)); break; }

    const d = compose(recipients[i]);
    const to = cleanHeader(d.to);

    const errs = T.validate(d);
    if (errs.length) { results.push({ to, ok: false, error: errs.join(" / ") }); continue; }

    // ─── 중복 발송 차단 ──────────────────────────────────────────
    // 화면에서 미리 확인했더라도 여기서 다시 잡는다 — 경합은 여기서만 막을 수 있다.
    let reserved = false;
    try {
      const rv = await H.reserve(d, {
        by: account.email, byName: account.name, campaign: d.campaignTitle || ""
      }, force);
      if (!rv.ok) {
        results.push({ to, ok: false, held: true, prior: rv.prior || null, error: heldReason(rv.prior) });
        H.logBlocked({
          to, handle: d.handle || "", name: d.creatorName || "",
          at: new Date().toISOString(),
          by: account.email, byName: account.name,
          campaign: d.campaignTitle || "",
          prior: rv.prior || null
        });
        continue;
      }
      // 본인 재발송(resent)은 기존 자리를 덮어쓴 것 — 실패해도 반납하지 않는다.
      reserved = !rv.skipped && !rv.resent;
    } catch (e) {
      // 저장소 장애 — 기본은 보내지 않는다(중복 방지). force 면 위험을 감수하고 진행.
      if (!force) {
        // 저장소 장애는 **모든 수신자**에 영향이다. 한 명씩 다시 시도하면 그때마다 저장소
        // 제한시간이 쌓여 함수 전체가 죽으므로, 여기서 배치를 멈추고 남은 사람은 미발송으로
        // 표시한다. 잠시 뒤 다시 [발송] 을 누르면 안 나간 사람만 처리된다(나간 사람은 이력에 있음).
        const msg = "이력 저장소에 연결하지 못해 보내지 않았습니다 (중복 방지). 잠시 후 다시 [발송] 을 " +
                    "누르면 남은 사람만 나갑니다 — " + String((e && e.message) || e);
        for (let k = i; k < recipients.length; k++) {
          results.push({ to: cleanHeader(compose(recipients[k]).to), ok: false, error: msg });
        }
        break;
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
        cc: ccList.length ? ccList : undefined,
        replyTo: account.email,
        bcc: process.env.NW_BCC || undefined,
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
      // 회신이 없으면 정한 주기로 팔로업을 보내도록 예약해 둔다 (크론이 처리)
      if (remindOn) {
        const now = Date.now();
        try {
          await H.scheduleReminder({
            to, creatorName: d.creatorName || "", handle: d.handle || "",
            by: account.email, byName: account.name, senderTitle: account.title || "",
            brand: d.brand || "", campaignTitle: d.campaignTitle || "",
            subject: built.subject, applyUrl: d.applyUrl || "", applyLabel: d.applyLabel || "",
            cc: ccList,   // 첫 메일의 참조가 리마인드에도 그대로 실리게
            intervalDays: followup.intervalDays, maxCount: followup.maxCount,
            reminderNotes: followup.notes, sentCount: 0,
            nextAt: new Date(now + followup.intervalDays * 86400e3).toISOString(),
            createdAt: new Date(now).toISOString()
          });
        } catch (_) { /* 예약 실패가 발송을 무르지는 않는다 */ }
      }
    } catch (e) {
      if (reserved) { try { await H.release(d); } catch (_) {} }
      results.push({ to, ok: false, error: String((e && e.message) || e) });
    }
  }

  transporter.close();

  const sent = results.filter(r => r.ok).length;
  const held = results.filter(r => r.held).length;
  return {
    results, leftover,
    sent, held,
    failed: results.length - sent - held
  };
}

module.exports = {
  sendBatch, composerFor, parseFollowup, parseDataImage,
  logoAttachment, logoDataUrl, logoUrl, cleanHeader, heldReason,
  SMTP_HOST, SMTP_PORT, SEND_GAP_MS, LOGO_CID, INLINE_IMG_CID
};
