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
  const mail = await M.read(account, {
    kind: "sent", since: o.since || SINCE_DEFAULT,
    limit: Math.max(1, Math.min(Number(o.limit) || 2000, 20000))
  });

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
  const mail = await M.read(account, {
    kind: "inbox", since: o.since || SINCE_DEFAULT,
    limit: Math.max(1, Math.min(Number(o.limit) || 2000, 20000))
  });

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
      // 원래 누가 어느 캠페인으로 보냈는지 — 담당자별 회신율을 세려면 필요하다
      by: hit.by || account.email,
      byName: hit.byName || account.name || "",
      campaign: hit.campaign || "",
      sentAt: hit.at || ""
    }, id);

    if (out.duplicate) duplicate++;
    else if (out.recorded) found++;
  }

  return { user: account.email, path: mail.path, scanned: mail.rows.length, found, duplicate };
}

// 한 사람의 보낸편지함·받은편지함을 잇달아 처리한다 (자동 실행이 쓰는 단위)
async function syncAccount(account, contacted, opts) {
  const o = opts || {};
  const sentRead = await readSent(account, o);
  const sentWrite = await writeSent(account, sentRead.rows);
  // 방금 넣은 발송분도 회신 대조 대상이 되도록 목록을 갱신한다
  sentRead.rows.forEach(r => {
    const k = H.normEmail(r.to);
    if (k && !contacted.has(k)) contacted.set(k, r);
  });
  const rep = await collectReplies(account, contacted, o);
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
