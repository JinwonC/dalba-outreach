// 메일함 → 이력 동기화 (공용 코어)
//
// 화면 버튼(api/backfill.js · api/replies.js)과 자동 실행(api/cron.js)이 **같은 코드**를
// 쓰도록 여기 모았다. 두 벌로 두면 한쪽만 고쳐져 "버튼으로는 되는데 자동은 안 되는"
// 상태가 조용히 생긴다.
//
//   ① 보낸편지함 → 발송 이력
//   ② 받은편지함 → 회신 기록 (우리가 보낸 적 있는 주소에서 온 것만)
//
// 제목·발신자·수신자만 읽는다. 본문은 가져오지 않는다.

const H = require("./history.js");
const M = require("./mail.js");

// 이력을 어느 날부터 채울지. 그 전 메일은 읽지 않는다.
const SINCE_DEFAULT = process.env.HISTORY_SINCE || "2026-05-01";

const COMPANY_DOMAINS = (process.env.NW_DOMAIN || "dalbausa.com,dalba.com")
  .split(",").map(s => s.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);

const MAX_RECIPIENTS = 5;   // 이보다 많으면 공지·회람으로 본다

function isInternal(email) {
  return COMPANY_DOMAINS.includes(String(email || "").toLowerCase().split("@")[1] || "");
}

// ─── 증분 스캔 커서 (자동 실행 전용) ───────────────────────────────
// 자동 실행이 매번 받은편지함 "최신 N통" 만 보면, 그 창(limit)을 넘긴 오래된 회신은
// 반복 실행해도 영영 안 걸린다. 그래서 계정별로 마지막에 처리한 UID 를 남겨 두고,
// 다음엔 그보다 큰(=이후) 것만 새로 본다. 커서는 **실제로 받아온 것 중 최대 UID** 로만
// 올린다 — 예산이 모자라 중간에 끊겨도(오래된 것부터 처리) 다음 실행이 이어받아 빈틈이 없다.
async function getUidCursor(kind, account) {
  try { return Number(await H.readRaw("outreach:cursor:" + kind + ":" + account.email)) || 0; }
  catch (_) { return 0; }
}
async function setUidCursor(kind, account, uid) {
  if (!(Number(uid) > 0)) return;
  try { await H.writeRaw("outreach:cursor:" + kind + ":" + account.email, String(uid)); } catch (_) {}
}
function maxUidOf(rows) {
  return (rows || []).reduce((m, r) => Math.max(m, Number(r && r.uid) || 0), 0);
}
// 커서를 쓸 땐 한 창을 넓게 잡는다(증분이라 매 실행 실제 건수는 적다). 안 쓰면(수동 전체
// 스캔) 기존 기본값을 유지한다.
function scanLimit(o) {
  return Math.max(1, Math.min(Number(o.limit) || (o.useCursor ? 20000 : 2000), 20000));
}

// 보낸 메일 한 통 → 이력 후보들 (수신자 한 명당 한 건)
function candidates(msg, account, needle) {
  if (needle && String(msg.subject || "").toLowerCase().indexOf(needle) < 0) return [];

  const people = (msg.toAll || []).concat(msg.ccAll || []);
  if (!people.length || people.length > MAX_RECIPIENTS) return [];

  return people
    .filter(p => p.email && !isInternal(p.email))
    .map(p => ({
      to: p.email,
      name: p.name || "",
      handle: "",                       // 메일에는 TikTok 핸들이 없다
      at: msg.at ? new Date(msg.at).toISOString() : "",
      by: account.email,
      byName: account.name || account.email.split("@")[0],
      campaign: msg.subject || "",
      source: "imap",                   // 도구로 보낸 기록과 구분
      messageId: msg.messageId || ""
    }));
}

// 보낸편지함을 읽어 후보를 뽑는다 (쓰지는 않는다 — 미리보기와 실행이 같은 결과를 보게)
async function readSent(account, opts) {
  const o = opts || {};
  const needle = String(o.subject || "").trim().toLowerCase();
  const minUid = o.useCursor ? await getUidCursor("sent", account) : 0;
  const mail = await M.read(account, {
    kind: "sent", since: o.since || SINCE_DEFAULT,
    limit: scanLimit(o), minUid, budgetMs: o.budgetMs
  });
  if (o.useCursor) await setUidCursor("sent", account, maxUidOf(mail.rows));

  const rows = [];
  const skipped = { internal: 0, bulk: 0, subject: 0 };
  mail.rows.forEach(msg => {
    const c = candidates(msg, account, needle);
    if (!c.length) {
      const people = (msg.toAll || []).concat(msg.ccAll || []);
      if (needle && String(msg.subject || "").toLowerCase().indexOf(needle) < 0) skipped.subject++;
      else if (people.length > MAX_RECIPIENTS) skipped.bulk++;
      else skipped.internal++;
      return;
    }
    rows.push(...c);
  });

  return { path: mail.path, truncated: mail.truncated, scanned: mail.rows.length, rows, skipped };
}

async function writeSent(account, rows) {
  let imported = 0, duplicate = 0, blocking = 0, expired = 0;
  for (const r of rows) {
    // messageId 가 없는 서버도 있으므로 계정+주소+시각으로 대체 키를 만든다
    const id = r.messageId || (account.email + "|" + r.to + "|" + r.at);
    const out = await H.importSend(r, id);
    if (out.duplicate) { duplicate++; continue; }
    if (out.imported) {
      imported++;
      if (out.blocking) blocking++;
      if (out.expired) expired++;
    }
  }
  return { imported, duplicate, blocking, expired };
}

// 우리가 보낸 적 있는 주소 — 이 목록에 없으면 회신이 아니다
async function contactedMap() {
  const log = await H.recent(H.LOG_MAX);
  const m = new Map();
  log.forEach(r => {
    const k = H.normEmail(r.to);
    if (!k) return;
    // 같은 사람에게 여러 번 보냈으면 가장 최근 발송을 기준으로 본다
    const cur = m.get(k);
    if (!cur || String(r.at || "") > String(cur.at || "")) m.set(k, r);
  });
  return m;
}

async function collectReplies(account, contacted, opts) {
  const o = opts || {};
  const minUid = o.useCursor ? await getUidCursor("inbox", account) : 0;
  const mail = await M.read(account, {
    kind: "inbox", since: o.since || SINCE_DEFAULT,
    limit: scanLimit(o), minUid, budgetMs: o.budgetMs
  });
  if (o.useCursor) await setUidCursor("inbox", account, maxUidOf(mail.rows));

  let found = 0, duplicate = 0;
  for (const m of mail.rows) {
    const hit = contacted.get(H.normEmail(m.from.email));
    if (!hit) continue;

    const at = m.at ? new Date(m.at).toISOString() : "";
    const id = m.messageId || (account.email + "|" + m.from.email + "|" + at);
    const out = await H.recordReply({
      from: m.from.email,
      fromName: m.from.name || "",
      at,
      subject: m.subject || "",
      inbox: account.email,          // 누구 받은편지함에 들어왔는지
      // 담당자 귀속은 **이 회신이 도착한 메일함 주인**이다 (account). 담당자 계정은
      // 크리에이터 아웃리치 전용이라, 그 메일함에 온 회신 = 그 담당자가 보낸 아웃리치의 답이다.
      // (contacted 전역 맵의 hit.by 로 잡으면, 같은 크리에이터를 여러 담당자가 접촉했을 때
      //  가장 최근 발송자에게 엉뚱하게 귀속돼 A 메일함 회신이 B 담당자로 뜬다.)
      by: account.email,
      byName: account.name || hit.byName || "",
      // 캠페인·원발송시각은 참고용 문맥 — 전역 맵 기준 best-effort
      campaign: hit.campaign || "",
      sentAt: hit.at || ""
    }, id);

    if (out.duplicate) duplicate++;
    else if (out.recorded) found++;
  }

  return { user: account.email, path: mail.path, scanned: mail.rows.length, found, duplicate };
}

// 한 사람의 보낸편지함·받은편지함을 잇달아 처리한다 (자동 실행이 쓰는 단위)
// 자동 실행은 **증분 스캔(커서)** 을 켠다 — 매번 전체를 다시 훑지 않고 이후 도착분만 본다.
// 보낸편지함은 짧게(도구로 보낸 건 실시간 기록됨 · 외부 발송만 보강), 받은편지함은 넉넉히
// (회신 누락이 제일 아프다) 예산을 준다. 함수 상한 60초 안에 한 계정을 마치도록 잡았다.
async function syncAccount(account, contacted, opts) {
  const o = Object.assign({ useCursor: true }, opts || {});
  const sentRead = await readSent(account, Object.assign({ budgetMs: 12000 }, o));
  const sentWrite = await writeSent(account, sentRead.rows);
  // 방금 넣은 발송분도 회신 대조 대상이 되도록 목록을 갱신한다
  sentRead.rows.forEach(r => {
    const k = H.normEmail(r.to);
    if (k && !contacted.has(k)) contacted.set(k, r);
  });
  const rep = await collectReplies(account, contacted, Object.assign({ budgetMs: 38000 }, o));
  return {
    user: account.email,
    sent: sentWrite,
    replies: { found: rep.found, duplicate: rep.duplicate },
    scanned: { sent: sentRead.scanned, inbox: rep.scanned }
  };
}

module.exports = {
  SINCE_DEFAULT, MAX_RECIPIENTS,
  candidates, readSent, writeSent, contactedMap, collectReplies, syncAccount
};
