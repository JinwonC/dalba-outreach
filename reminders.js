// 자동 리마인드(팔로업) 발송 — 크론이 매일 부른다.
//
// 첫 메일에 회신이 없으면, 담당자가 발송 시 정한 주기(며칠마다)·횟수(최대 몇 번)에 따라
// 같은 크리에이터에게 짧은 팔로업을 다시 보낸다. 상태는 history.js 의 리마인드 예약(HASH)에
// 저장돼 있고, 여기서는 **기한이 된 것**만 골라 보낸다.
//
// 멈추는 조건: ① 크리에이터가 회신함 ② 정한 횟수를 다 채움 ③ 담당자가 명단에서 빠짐.
// 회신 여부는 회신 기록(recordReply)으로 판단한다 — 크론은 메일함 동기화를 먼저 돌린 뒤
// 이 함수를 부르므로 회신 데이터가 최신이다.

const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const T = require("./email-template.js");
const A = require("./auth.js");
const H = require("./history.js");

const SMTP_HOST = process.env.NW_SMTP_HOST || "smtp.worksmobile.com";
const SMTP_PORT = Number(process.env.NW_SMTP_PORT || 465);
const SEND_GAP_MS = 1100;                 // 유량 제한(60/min) 회피
const LOGO_CID = "dalbalogo@dalba";
const sleep = ms => new Promise(r => setTimeout(r, ms));

function cleanHeader(s) { return String(s == null ? "" : s).replace(/[\r\n]+/g, " ").trim(); }

// 로고를 메일에 인라인(cid)으로 박는다 (외부 URL 은 배포 보호 등으로 깨질 때가 있다).
// LOGO_URL 을 명시한 배포는 그 URL 을 그대로 쓴다.
let logoBuf;
function logoAttachment() {
  if (process.env.LOGO_URL) return null;
  if (logoBuf === undefined) {
    try { logoBuf = fs.readFileSync(path.join(__dirname, "logo-black.png")); } catch (_) { logoBuf = null; }
  }
  return logoBuf ? { filename: "logo.png", content: logoBuf, contentType: "image/png", cid: LOGO_CID, contentDisposition: "inline" } : null;
}
function logoUrl() {
  if (process.env.LOGO_URL) return process.env.LOGO_URL;
  return logoAttachment() ? "cid:" + LOGO_CID : "";
}

function transporterFor(account) {
  return nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465, requireTLS: SMTP_PORT !== 465,
    auth: { user: account.email, pass: account.appPassword },
    pool: true, maxConnections: 1,
    connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 25000
  });
}

// 회신한 (크리에이터, 담당자) 쌍의 키 집합 — 이 집합에 있으면 리마인드를 멈춘다.
function repliedKeys(replies) {
  const set = new Set();
  (replies || []).forEach(function (r) {
    const from = r.from;
    if (r.by) set.add(H.reminderKey(from, r.by));
    if (r.inbox) set.add(H.reminderKey(from, r.inbox));
  });
  return set;
}

// 기한이 된 리마인드를 보낸다. now/budgetMs 는 테스트·크론 예산용.
async function sendDue(opts) {
  const o = opts || {};
  if (!H.enabled()) return { skipped: "no-store", due: 0, sent: 0 };
  const now = o.now ? new Date(o.now).getTime() : Date.now();
  const deadline = now + Math.max(5000, Number(o.budgetMs) || 40000);

  const [plans, replies] = await Promise.all([H.allReminders(), H.recentReplies(H.REPLY_MAX)]);
  const replied = repliedKeys(replies);
  const logo = logoAttachment();
  const attachments = logo ? [logo] : undefined;

  const transports = new Map();
  const getT = account => {
    if (!transports.has(account.email)) transports.set(account.email, transporterFor(account));
    return transports.get(account.email);
  };

  const summary = { due: 0, sent: 0, replied: 0, exhausted: 0, failed: 0, skipped: 0 };
  let lastAt = 0;

  try {
    for (const plan of plans) {
      if (plan.done) continue;
      const dueAt = Date.parse(plan.nextAt || "");
      if (!isFinite(dueAt) || dueAt > now) continue;     // 아직 기한 전
      summary.due++;
      if (Date.now() > deadline) { summary.skipped++; continue; }   // 다음 실행이 이어받는다

      // ① 회신했으면 멈춘다
      if (replied.has(plan.key)) { await H.cancelReminder(plan.key); summary.replied++; continue; }

      // ② 횟수를 다 채웠으면 멈춘다
      const maxCount = Math.max(1, Math.min(Number(plan.maxCount) || 2, 10));
      const sentCount = Number(plan.sentCount) || 0;
      if (sentCount >= maxCount) { await H.cancelReminder(plan.key); summary.exhausted++; continue; }

      // ③ 담당자가 명단에서 빠졌으면 보낼 수 없다
      const account = A.findByEmail(plan.by);
      if (!account || !account.appPassword) { await H.cancelReminder(plan.key); summary.skipped++; continue; }

      // 이번에 보내는 회차의 문구를 고른다 — sentCount 는 지금까지 보낸 수라, 이번은 (sentCount+1)차.
      // reminderNotes[sentCount] 가 0-based 로 그 회차 문구다. 비었으면 템플릿 기본 문구로 나간다.
      const notes = Array.isArray(plan.reminderNotes) ? plan.reminderNotes : [];
      const roundNote = String(notes[sentCount] || plan.reminderNote || "").trim();

      const data = {
        reminder: true,
        to: plan.to, creatorName: plan.creatorName || "", handle: plan.handle || "",
        brand: plan.brand || "d'Alba", campaignTitle: plan.campaignTitle || "",
        subject: plan.subject || "", reminderNote: roundNote,
        applyUrl: plan.applyUrl || "", applyLabel: plan.applyLabel || "",
        senderName: account.name, senderEmail: account.email, senderTitle: account.title || "",
        logoUrl: logoUrl()
      };
      const built = T.build(data);
      const to = cleanHeader(plan.to);
      const toName = cleanHeader(plan.creatorName || "");

      if (lastAt) { const wait = SEND_GAP_MS - (Date.now() - lastAt); if (wait > 0) await sleep(wait); }
      lastAt = Date.now();

      try {
        // 첫 메일에 걸었던 참조(CC)를 리마인드에도 그대로 싣는다 — 참조로 지켜보던
        // 스레드가 리마인드부터 끊기지 않도록. 예약에 저장된 주소만 쓴다.
        const ccList = (Array.isArray(plan.cc) ? plan.cc : [])
          .map(s => cleanHeader(s)).filter(s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
        await getT(account).sendMail({
          from: { name: cleanHeader(account.name), address: account.email },
          to: toName ? { name: toName, address: to } : to,
          replyTo: account.email,
          cc: ccList.length ? ccList : undefined,
          bcc: process.env.NW_BCC || undefined,
          subject: cleanHeader(built.subject),
          text: built.text, html: built.html,
          attachments: attachments
        });
        const nextCount = sentCount + 1;
        const at = new Date().toISOString();
        if (nextCount >= maxCount) {
          await H.cancelReminder(plan.key);              // 마지막 리마인드였다
        } else {
          const next = new Date(now + Math.max(1, Number(plan.intervalDays) || 3) * 86400e3).toISOString();
          await H.saveReminder(plan.key, Object.assign({}, plan, { sentCount: nextCount, lastAt: at, nextAt: next }));
        }
        await H.logReminderSent({
          to: plan.to, name: plan.creatorName || "", handle: plan.handle || "",
          by: account.email, byName: account.name, at: at,
          n: nextCount, of: maxCount, campaign: plan.campaignTitle || ""
        });
        summary.sent++;
      } catch (e) {
        summary.failed++;
        // 실패는 계획을 지우지 않는다 — 다음 실행에서 다시 시도한다
      }
    }
  } finally {
    transports.forEach(function (t) { try { t.close(); } catch (_) {} });
  }
  return summary;
}

module.exports = { sendDue, repliedKeys };
