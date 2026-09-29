// 시스템 상태 점검 — 관리자 페이지 맨 위 경고줄에 쓴다. 저장된 상태만 읽어 판단한다(메일함에 붙지 않음).
//
//   크론(15분마다)이 멈췄는지 · 메일함 동기화가 한 바퀴를 오래 못 돌았는지
//   담당자별 동기화 실패(앱 비밀번호·보낸편지함 폴더 등) · 오래 동기화 안 된 메일함 · 메일 본문 저장 공간 가득
//
// 입력: { now, cron(마지막 크론 상태), syncAt(마지막으로 한 바퀴 끝난 시각), staff:[{email,name}], info: Map(email → syncinfo) }
// 출력: { ok, items:[{ level:"error"|"warn"|"info", code, msg, name?, text, staff?, detail?, hint? }] }

const CRON_STALE_MS = 45 * 60e3;       // 크론은 15분마다 — 45분 넘게 소식이 없으면 멈춘 것
const ROUND_STALE_MS = 3 * 3600e3;     // 동기화는 1시간마다 한 바퀴 — 3시간 넘게 못 돌면 경고
const MAILBOX_STALE_MS = 6 * 3600e3;   // 한 메일함이 6시간 넘게 동기화 안 됨

function hint(err) {
  const e = String(err || "");
  if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|authentication failed|auth.*fail|비밀번호/i.test(e)) return "앱 비밀번호가 바뀌었거나 만료됐을 수 있습니다 — 네이버웍스에서 외부 앱 비밀번호를 새로 받아 Vercel 의 NW_ACCOUNTS 에 넣어 주세요";
  if (/보낸편지함 폴더를 찾지 못했습니다/.test(e)) return "보낸편지함 폴더 이름이 달라 찾지 못했습니다 — 폴더 목록을 확인해 주세요";
  if (/이력 저장소/.test(e)) return "저장소(Upstash) 문제입니다 — 요금제·한도를 확인해 주세요";
  if (/timeout|timed out|ETIMEDOUT|ECONNRESET|ENOTFOUND/i.test(e)) return "메일 서버 연결이 끊겼습니다 — 잠깐이면 다음 동기화에서 풀립니다";
  return "";
}

function ago(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? m + "분" : Math.round(m / 60) + "시간";
}

function evaluate(o) {
  const now = Number(o && o.now) || Date.now();
  const items = [];
  const cron = o && o.cron;
  const cronAt = Date.parse(cron && cron.at || "");
  if (!isFinite(cronAt)) items.push({ level: "error", code: "cron-missing", msg: "자동 실행(크론)이 한 번도 돈 기록이 없습니다 — Vercel 의 Cron Jobs 설정을 확인해 주세요" });
  else if (now - cronAt > CRON_STALE_MS) items.push({ level: "error", code: "cron-stale", msg: "자동 실행(크론)이 " + ago(now - cronAt) + " 동안 돌지 않았습니다 — 예약 발송·리마인드·동기화가 멈춰 있습니다" });
  if (cron && cron.scheduled && cron.scheduled.error) items.push({ level: "error", code: "scheduled-error", msg: "예약 발송 처리 오류", detail: String(cron.scheduled.error) });
  if (cron && cron.reminders && cron.reminders.error) items.push({ level: "error", code: "reminders-error", msg: "자동 리마인드 처리 오류", detail: String(cron.reminders.error) });

  const syncAt = Date.parse(o && o.syncAt || "");
  if (isFinite(cronAt) && isFinite(syncAt) && now - syncAt > ROUND_STALE_MS)
    items.push({ level: "warn", code: "round-stale", msg: "메일함 동기화가 " + ago(now - syncAt) + " 동안 한 바퀴를 끝내지 못했습니다 — 회신·주소록 숫자가 늦을 수 있습니다" });

  const info = (o && o.info) || new Map();
  ((o && o.staff) || []).forEach(s => {
    const email = String(s.email || "").toLowerCase();
    const x = info.get(email);
    const who = s.name || email;
    if (!x) { items.push({ level: "info", code: "never-synced", staff: email, name: who, msg: "아직 메일함 동기화 기록이 없습니다" }); return; }
    if (x.error) { items.push({ level: "error", code: "sync-error", staff: email, name: who, msg: "메일함 동기화 실패", detail: String(x.error), hint: hint(x.error) }); return; }
    const at = Date.parse(x.at || "");
    if (isFinite(at) && now - at > MAILBOX_STALE_MS) items.push({ level: "warn", code: "mailbox-stale", staff: email, name: who, msg: "메일함 동기화가 " + ago(now - at) + " 전이 마지막입니다" });
    if (x.msgsFull) items.push({ level: "warn", code: "msgs-full", staff: email, name: who, msg: "메일 본문 저장 공간이 가득 차 새 메일은 본문 없이 저장됩니다 (MSG_STORE_MAX_MB)" });
    if (x.msgsError) items.push({ level: "warn", code: "msgs-error", staff: email, name: who, msg: "메일 저장 오류", detail: String(x.msgsError) });
    if (x.bounceError) items.push({ level: "warn", code: "bounce-error", staff: email, name: who, msg: "반송 알림 확인 오류", detail: String(x.bounceError) });
    if (x.waiting) items.push({ level: "info", code: "catching-up", staff: email, name: who, msg: "보낸편지함을 처음부터 읽는 중입니다 (회신 판정은 다 읽은 뒤에)" });
  });
  // text = 한 줄 전체(담당자 이름 — 내용). 화면은 이름과 내용(msg)을 따로 그려 내용만 번역한다.
  items.forEach(i => { i.text = (i.name ? i.name + " — " : "") + i.msg; });
  const rank = { error: 0, warn: 1, info: 2 };
  items.sort((a, b) => rank[a.level] - rank[b.level]);
  return { ok: !items.some(i => i.level !== "info"), items };
}

module.exports = { evaluate, hint, CRON_STALE_MS, ROUND_STALE_MS, MAILBOX_STALE_MS };
