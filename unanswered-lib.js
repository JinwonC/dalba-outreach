// 답장 대기 — 크리에이터가 회신했는데 우리 쪽(그 메일함)이 아직 답하지 않은 대화.
// 발송 화면(api/pipeline.js ?view=unanswered, 본인 것)과 관리자 페이지(api/admin.js ?view=unanswered)가
// 같은 기준을 쓰도록 한 곳에 둔다.
//
// 판정 (메일함 하나 기준):
//   받은 쪽 마지막 = 받은 주소록(그 메일함으로 들어온 그 주소의 마지막 메일)
//   보낸 쪽 마지막 = 보낸 주소록(웹메일·단체·숨은참조) · 툴 발송 기록 · 자동 리마인드 기록 중 가장 최근
//   받은 쪽 마지막이 보낸 쪽 마지막보다 **나중**이면 → 답장 대기.
// 우리가 먼저 연락한 적이 있는 상대만 본다(보낸 흔적이 있거나, 그 메일함에 회신으로 기록된 상대) —
// 광고·뉴스레터 같은 모르는 발신자는 빼기 위해. 자동 응답(부재중 등)과 발송 실패 알림도 뺀다.
//
// 저장소 요청: 메일함마다 주소록 2개(HGETALL) + 발송·회신·리마인드 기록(LRANGE 몇 번, 여러 메일함이 공유).
// 보낸 주소록은 동기화(1시간마다) 때 갱신되므로, 웹메일로 답한 건 다음 동기화 뒤에 목록에서 빠진다.

const H = require("./history.js");

// 사람이 아닌 발신자 (주소 앞부분)
const ROBOT_RE = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|bounce|daemon)\b/i;
// 자동 응답·발송 실패 알림 제목
const AUTO_SUBJ_RE = /(out of (the )?office|automatic reply|auto(matic)?[- ]?reply|autoreply|부재|자동 ?회신|자동 ?응답|undeliver|delivery status notification|mail delivery (failed|subsystem)|returned mail|발송 ?실패|전송 ?실패)/i;

// 여러 메일함이 함께 쓰는 기록(발송·회신·리마인드)을 한 번만 읽는다
async function loadShared() {
  const [sent, replies, rems] = await Promise.all([
    H.recent(H.LOG_MAX), H.recentReplies(H.REPLY_MAX), H.recentReminders(H.LOG_MAX)
  ]);
  return { sent: sent || [], replies: replies || [], rems: rems || [] };
}

// mailbox: 담당자 메일함 주소, shared: loadShared() 결과, o: { days } (받은 지 N일 안만, 기본 60)
async function unansweredFor(mailbox, shared, o) {
  const mb = H.normEmail(mailbox);
  const days = Math.max(1, Number(o && o.days) || 60);
  const now = Date.now();
  const [recv, sentBook] = await Promise.all([H.bookAll("recv", mb), H.bookAll("sent", mb)]);

  const lastOut = new Map();          // 상대 → 이 메일함의 마지막 보낸 시각
  const bump = (e, at) => { e = H.normEmail(e); if (!e || !at) return; if (String(at) > String(lastOut.get(e) || "")) lastOut.set(e, String(at)); };
  sentBook.forEach(b => bump(b.email, b.last || b.first));
  const info = new Map();             // 상대 → { name, handle } (툴 발송 기록에서)
  shared.sent.forEach(r => {
    if (!r || H.normEmail(r.by) !== mb) return;
    bump(r.to, r.at);
    const e = H.normEmail(r.to), x = info.get(e) || {};
    if (!x.name && r.name) x.name = r.name;
    if (!x.handle && r.handle) x.handle = H.normHandle(r.handle);
    info.set(e, x);
  });
  shared.rems.forEach(r => { if (r && H.normEmail(r.by) === mb) bump(r.to, r.at); });
  const repliedHere = new Set();      // 이 메일함에 '회신'으로 기록된 상대
  shared.replies.forEach(r => { if (r && H.normEmail(r.inbox || r.by) === mb) repliedHere.add(H.normEmail(r.from)); });

  const rows = [];
  recv.forEach(b => {
    const e = H.normEmail(b.email);
    const lastIn = b.last || "";
    if (!e || !lastIn || e === mb) return;
    if (ROBOT_RE.test(e.split("@")[0])) return;
    if (b.subj && AUTO_SUBJ_RE.test(b.subj)) return;
    const out = lastOut.get(e) || "";
    if (!out && !repliedHere.has(e)) return;               // 우리가 연락한 적 없는 상대
    const tIn = Date.parse(lastIn);
    if (!isFinite(tIn) || now - tIn > days * 86400e3) return;
    if (out && Date.parse(out) >= tIn) return;              // 이미 답함
    const x = info.get(e) || {};
    rows.push({
      email: e, name: b.name || x.name || "", handle: x.handle || "",
      lastIn, lastOut: out, subject: b.subj || "", inCount: Number(b.n) || 1,
      waitingDays: Math.max(0, Math.floor((now - tIn) / 86400e3))
    });
  });
  // 오래 기다린 순
  rows.sort((a, b) => String(a.lastIn).localeCompare(String(b.lastIn)));
  return rows;
}

module.exports = { loadShared, unansweredFor, ROBOT_RE, AUTO_SUBJ_RE };
