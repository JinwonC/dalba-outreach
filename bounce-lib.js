// 반송(발송 실패) 메일 해석 — 받은편지함에 돌아온 "보낼 수 없음" 알림에서 **없는 주소**를 찾아낸다.
//
// 안전장치 (잘못 막지 않도록):
//   · 우리가 실제로 보낸 적 있는 주소만 반송으로 기록한다 (알림 본문에 섞인 다른 주소 무시)
//   · 영구 실패(주소 없음·거부)만 — 일시 실패(메일함 가득 참·잠시 후 재시도)는 기록하지 않는다
//   · 발송자 본인·회사 주소·시스템 주소(mailer-daemon 등)는 제외
// 잘못 들어간 주소는 관리자 페이지 [⛔ 발송 제외] 에서 지울 수 있다.

// 반송 알림으로 보이는 메일 (보낸 사람·제목)
const DAEMON_RE = /^(mailer-daemon|postmaster|mail-daemon|maildelivery|mailerdaemon|bounce[s]?)(@|$)/i;
const BOUNCE_SUBJ_RE = /(undeliver|delivery status notification|delivery (has )?failed|failure notice|returned mail|mail delivery (failed|subsystem)|message not delivered|could not be delivered|발송 ?실패|전송 ?실패|배달 ?실패|메일 ?반송|반송 ?안내)/i;

// 영구 실패 표시 (SMTP 5xx · 확장 코드 5.1.x · 문구)
const HARD_RE = /(\b5\.1\.\d\b|\b5\.4\.[14]\b|\b5\.2\.1\b|\b550\b|\b551\b|\b553\b|user unknown|unknown user|no such user|user not found|does(n't| not) exist|address not found|recipient address rejected|invalid recipient|recipient not found|mailbox unavailable|mailbox not found|account (has been )?(disabled|deactivated)|address couldn'?t be found|존재하지 ?않|없는 ?(메일 ?)?주소|수신자를 찾을 수|받는 ?사람을 찾을 수|주소를 찾을 수)/i;
// 일시 실패 표시 — 이것만 있으면 기록하지 않는다
const SOFT_RE = /(\b4\.\d\.\d\b|\b4[25]\d\b|mailbox (is )?full|over ?quota|quota exceeded|temporar|try again later|용량 ?초과|일시적)/i;

const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function normEmail(e) { return String(e || "").trim().toLowerCase().replace(/^<|>$/g, ""); }

function isBounceMessage(m) {
  const from = normEmail(m && (m.from && m.from.email || m.from));
  const subj = String((m && m.subject) || "");
  return DAEMON_RE.test(from) || BOUNCE_SUBJ_RE.test(subj);
}

// raw: 알림 원문(헤더·본문·첨부 일부), o: { me, isInternal(e), sentTo(e) → bool }
// → [{ email, reason }]  (영구 실패로 판단된 주소만)
function failedRecipients(raw, o) {
  const text = String(raw || "");
  const me = normEmail(o && o.me);
  // 맨 숫자 코드(550 등)는 스팸·정책 거절에도 쓰이므로 문구나 확장 코드(5.1.x 등)로만 판단한다
  const hard = text.replace(/\b\d{3}\b/g, " ").match(HARD_RE);
  if (!hard) return [];
  // 표준 DSN 이 있으면 그 주소를 우선 (Final-Recipient: rfc822; addr)
  const dsn = [...text.matchAll(/(?:Final|Original)-Recipient:\s*rfc822;\s*<?([^\s>;]+@[^\s>;]+)>?/gi)].map(x => normEmail(x[1]));
  const cands = dsn.length ? dsn : (text.match(EMAIL_RE) || []).map(normEmail);
  const out = [], seen = new Set();
  for (const e of cands) {
    if (!e || seen.has(e)) continue;
    seen.add(e);
    if (e === me || DAEMON_RE.test(e)) continue;
    if (o && o.isInternal && o.isInternal(e)) continue;
    if (o && o.sentTo && !o.sentTo(e)) continue;          // 우리가 보낸 적 없는 주소는 무시
    out.push({ email: e, reason: hard[0].slice(0, 80) });
  }
  // 영구 실패 문구 없이 일시 실패만 있는 경우는 위에서 이미 걸렀다 (hard 필수).
  // 둘 다 있으면(예: 4xx 재시도 끝에 5xx) 영구 실패로 본다.
  return out;
}

// SMTP 가 발송 즉시 거절한 오류가 '없는 주소'인지 (nodemailer 오류 객체)
function isHardSmtpError(err) {
  if (!err) return false;
  const code = Number(err.responseCode) || 0;
  const msg = String(err.response || err.message || "");
  if (code >= 400 && code < 500) return false;
  // 550 은 스팸 정책 거절에도 쓰이므로 코드만으로는 안 된다 — 확장 코드 5.1.x 또는 '없는 주소' 문구가 있어야
  const words = msg.replace(/\b\d{3}\b/g, " ");
  return /\b5\.1\.[0-9]\b/.test(msg) || ((code === 550 || code === 551 || code === 553) && HARD_RE.test(words));
}

module.exports = { isBounceMessage, failedRecipients, isHardSmtpError, HARD_RE, SOFT_RE, DAEMON_RE, BOUNCE_SUBJ_RE };
