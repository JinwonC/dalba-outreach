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
// recipients: 훑은 메일의 **모든 외부 수신자** (받는사람·참조·숨은참조, 인원 제한 없음) —
// 발송 이력엔 안 넣고(단체 메일은 공지일 수 있음) 회신 판별용 '보낸 적 있는 주소'로만 쓴다.
async function readSent(account, opts) {
  const o = opts || {};
  const needle = String(o.subject || "").trim().toLowerCase();
  const ck = o.cursorKey || "sent";
  const minUid = o.useCursor ? await getUidCursor(ck, account) : 0;
  const mail = await M.read(account, {
    kind: "sent", since: o.since || SINCE_DEFAULT,
    limit: scanLimit(o), minUid, budgetMs: o.budgetMs, oldestFirst: Boolean(o.oldestFirst)
  });
  // deferCursor: 호출한 쪽이 결과를 저장한 **뒤에** 커서를 올린다 (저장 실패 시 다시 읽도록)
  const nextCursor = maxUidOf(mail.rows);
  if (o.useCursor && !o.deferCursor) await setUidCursor(ck, account, nextCursor);

  const rows = [];
  const recipients = new Set();
  const book = new Map();   // 주소 → { n, first, last, subj, name } (o.book 일 때만)
  const skipped = { internal: 0, bulk: 0, subject: 0 };
  mail.rows.forEach(msg => {
    const at = msg.at ? new Date(msg.at).toISOString() : "";
    const seen = new Set();   // 한 메일에 같은 사람이 받는사람·참조로 두 번 있어도 1통
    (msg.toAll || []).concat(msg.ccAll || [], msg.bccAll || []).forEach(p => {
      const e = H.normEmail(p.email);
      if (!e || isInternal(e) || e.indexOf("@") < 1) return;
      recipients.add(e);
      if (o.book && !seen.has(e)) { seen.add(e); bookAdd(book, e, at, msg.subject, p.name); }
    });
    if (o.recipientsOnly) return;
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

  return { path: mail.path, truncated: mail.truncated, scanned: mail.rows.length, rows, skipped, recipients: [...recipients], book, nextCursor, cursorKey: ck };
}

async function writeSent(account, rows) {
  // 한 번에 일괄로 (한 통씩 저장소를 왕복하면 과거분 가져오기가 함수 제한시간을 넘긴다).
  // messageId 가 없는 서버도 있으므로 계정+주소+시각으로 대체 키를 만든다.
  // 한 메일에 수신자가 여럿이면 메일 id 에 주소를 붙여 사람마다 따로 기록한다.
  // (예전엔 같은 메일의 수신자들이 id 를 공유해 **첫 수신자만** 기록됐다. 첫 수신자는 예전 id 를 그대로 써서
  //  이미 가져온 건 다시 쌓지 않고, 나머지 수신자는 id 에 주소를 붙여 새로 기록한다.)
  const firstSeen = new Set();
  return H.importSends((rows || []).map(r => {
    let id;
    if (r.messageId) {
      id = firstSeen.has(r.messageId) ? r.messageId + "|" + H.normEmail(r.to) : r.messageId;
      firstSeen.add(r.messageId);
    } else id = account.email + "|" + r.to + "|" + r.at;
    return { rec: r, id };
  }));
}

// 우리가 보낸 적 있는 주소 (전 담당자 발송 이력)
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

// ─── 폴더별 증분 커서 (회신 판별 v2) ──────────────────────────────
// 기준이 바뀌었으므로 새 키로 시작한다 → 5월부터 전부 새 기준으로 다시 평가된다.
// v3: 받은 주소록을 채우려고 한 번 더 5월부터 훑는다 (회신 기록은 messageId 로 중복 방지)
const boxCursorKey = acct => "outreach:cursor:box3:" + H.normEmail(acct.email);
async function getBoxCursors(acct) {
  try { return JSON.parse(await H.readRaw(boxCursorKey(acct)) || "{}") || {}; } catch (_) { return {}; }
}
async function setBoxCursors(acct, map) {
  try { await H.writeRaw(boxCursorKey(acct), JSON.stringify(map || {})); } catch (_) {}
}

// 주소록 집계: 이번에 훑은 메일들을 주소별로 합친다 (저장은 H.bookMerge)
function bookAdd(map, e, at, subj, name, box) {
  let a = map.get(e);
  if (!a) { a = { n: 0, first: "", last: "", subj: "", name: "", box: "" }; map.set(e, a); }
  a.n++;
  if (at && (!a.first || at < a.first)) a.first = at;
  if (!a.last || String(at || "") >= a.last) { a.last = at || a.last; a.subj = subj || a.subj; if (box) a.box = box; }
  if (!a.name && name) a.name = name;
}

// 이 메일에서 '회신'인지 판정: 회사 밖 발신자 + (전 담당자 발송 기록 | 이 메일함이 보낸 적 있는 주소)
function classify(m, account, contacted, sentTo) {
  const e = H.normEmail(m.from && m.from.email);
  if (!e || e.indexOf("@") < 1) return { kind: "none" };
  if (e === H.normEmail(account.email) || isInternal(e)) return { kind: "internal", e };
  const hit = contacted.get(e);
  if (hit) return { kind: "reply", e, hit, via: "log" };
  if (sentTo && sentTo.has(e)) return { kind: "reply", e, hit: null, via: "sent-folder" };
  return { kind: "not-contacted", e };
}

// 받은편지함 + 사용자 폴더(보낸편지함·임시·휴지통·스팸 제외)를 훑어 회신을 기록한다.
//   useCursor: 폴더별 증분(자동 실행). 아니면 폴더마다 최신 limit 통 전체(수동 수집).
async function collectReplies(account, contacted, opts) {
  const o = opts || {};
  const sentTo = o.sentTo || await H.sentToSet(account.email);
  const cursors = o.useCursor ? await getBoxCursors(account) : {};
  const res = await M.readFolders(account, {
    since: o.since || SINCE_DEFAULT, limit: scanLimit(o), cursors, budgetMs: o.budgetMs
  });

  let found = 0, duplicate = 0, scanned = 0, notContacted = 0;
  const items = [];
  const recv = new Map();   // 받은 주소록 — 회사 밖 발신자 전부 (회신 여부와 무관)
  const next = Object.assign({}, cursors);
  for (const f of res.folders) {
    for (const m of f.rows) {
      scanned++;
      const c = classify(m, account, contacted, sentTo);
      const at = m.at ? new Date(m.at).toISOString() : "";
      if (c.kind === "reply" || c.kind === "not-contacted") bookAdd(recv, c.e, at, m.subject, m.from && m.from.name, f.path);
      if (c.kind === "not-contacted") { notContacted++; continue; }
      if (c.kind !== "reply") continue;
      items.push({
        id: m.messageId || (account.email + "|" + m.from.email + "|" + at),
        rec: {
          from: m.from.email, fromName: m.from.name || "", at, subject: m.subject || "",
          inbox: account.email,          // 회신이 도착한 메일함 = 담당자
          by: account.email, byName: account.name || (c.hit && c.hit.byName) || "",
          campaign: (c.hit && c.hit.campaign) || "", sentAt: (c.hit && c.hit.at) || "",
          box: f.path, via: c.via
        }
      });
    }
    // 받아온 것 중 최대 UID 까지만 커서를 올린다 (예산으로 끊겨도 다음 실행이 이어받는다)
    const mx = maxUidOf(f.rows);
    if (mx > (Number(next[f.path]) || 0)) next[f.path] = mx;
  }
  const out = await H.recordReplies(items);
  found = out.recorded; duplicate = out.duplicate;
  // 주소록은 커서를 쓰는 실행에서만 더한다 — 커서 없이 다시 훑으면 같은 메일을 두 번 센다
  if (o.useCursor) await H.bookMerge("recv", account.email, recv);
  // 기록을 마친 뒤에 커서를 저장한다 — 기록 전에 올리면, 도중에 끊길 때 그 회신이 영영 빠진다
  if (o.useCursor) await setBoxCursors(account, next);

  return {
    user: account.email,
    path: res.folders.map(f => f.path).join(", "),
    folders: res.folders.map(f => ({ path: f.path, scanned: f.rows.length, total: f.total, truncated: f.truncated, skipped: f.skipped })),
    scanned, found, duplicate, notContacted
  };
}

// 보낸편지함 → '보낸 적 있는 주소'(회신 판별) + 보낸 주소록. 자체 커서로 매번 이어서 처리한다.
// 처음엔 5월부터 과거분을 채우고, 그 뒤엔 새로 보낸 메일만. 한 번이라도 끝까지 따라잡으면 ready.
const BOOK_READY = acct => "outreach:book:sent:ready:" + H.normEmail(acct.email || acct);
async function bookReady(acct) { try { return (await H.readRaw(BOOK_READY(acct))) === "1"; } catch (_) { return false; } }
async function scanSentBook(account, budgetMs) {
  const r = await readSent(account, { useCursor: true, deferCursor: true, cursorKey: "booksent", recipientsOnly: true, book: true, budgetMs });
  await H.addSentTo(account.email, r.recipients);
  await H.bookMerge("sent", account.email, r.book);
  await setUidCursor("booksent", account, r.nextCursor);   // 저장을 마친 뒤에 커서를 올린다
  const caughtUp = !r.truncated;
  if (caughtUp) { try { await H.writeRaw(BOOK_READY(account), "1"); } catch (_) {} }
  return { caughtUp, scanned: r.scanned, addresses: r.book.size, sentFolder: r.path };
}

// ─── 메일 데이터베이스 패스 (본문까지 저장) ─────────────────────────
// 주소록·회신 판정과 **따로** 자체 커서로 돈다 — 5월부터 전부 저장하고, 이후엔 새 메일만.
// (주소록 커서와 섞으면 과거분을 다시 읽을 때 주소록 숫자가 두 번 세어진다)
// 회사 밖 상대가 있는 메일만: 보낸편지함은 외부 수신자가 있을 때, 받은 쪽은 외부 발신자일 때.
const msgBoxKey = acct => "outreach:cursor:msgbox:" + H.normEmail(acct.email);
async function storeMessagesPass(account, budgetMs) {
  const until = Date.now() + Math.max(4000, Number(budgetMs) || 20000);
  const me = H.normEmail(account.email);
  let stored = 0, noText = 0, full = false, sentCaughtUp = false, boxesCaughtUp = false;
  const idOf = (m, at) => m.messageId || (account.email + "|" + (m.uid || "") + "|" + at);

  // ① 보낸편지함
  const sMin = await getUidCursor("msgsent", account);
  const sent = await M.read(account, { kind: "sent", since: SINCE_DEFAULT, limit: 20000, minUid: sMin,
    budgetMs: Math.max(3000, Math.floor((until - Date.now()) * 0.4)), withBody: true });
  const sItems = [];
  for (const m of sent.rows) {
    const ext = [...new Set((m.toAll || []).concat(m.ccAll || [], m.bccAll || []).map(p => H.normEmail(p.email))
      .filter(e => e && e.indexOf("@") > 0 && !isInternal(e)))];
    if (!ext.length) continue;
    const at = m.at ? new Date(m.at).toISOString() : "";
    sItems.push({ id: idOf(m, at), dir: "out", at, from: me,
      to: (m.toAll || []).map(p => p.email), cc: (m.ccAll || []).map(p => p.email), bcc: (m.bccAll || []).map(p => p.email),
      subject: m.subject || "", box: sent.path, text: m.text || "", peers: ext });
  }
  let r = await H.storeMessages(account.email, sItems);
  stored += r.stored; noText += r.noText; full = full || r.full;
  await setUidCursor("msgsent", account, maxUidOf(sent.rows));   // 저장을 마친 뒤에 커서를 올린다
  sentCaughtUp = !sent.truncated;

  // ② 받은편지함 + 사용자 폴더
  if (until - Date.now() > 3000) {
    let cursors = {};
    try { cursors = JSON.parse(await H.readRaw(msgBoxKey(account)) || "{}") || {}; } catch (_) { cursors = {}; }
    const res = await M.readFolders(account, { since: SINCE_DEFAULT, limit: 20000, cursors, budgetMs: until - Date.now(), withBody: true });
    const rItems = [];
    const next = Object.assign({}, cursors);
    for (const f of res.folders) {
      for (const m of f.rows) {
        const e = H.normEmail(m.from && m.from.email);
        if (!e || e.indexOf("@") < 1 || e === me || isInternal(e)) continue;
        const at = m.at ? new Date(m.at).toISOString() : "";
        rItems.push({ id: idOf(m, at) + (m.messageId ? "" : "|" + f.path), dir: "in", at, from: e, fromName: (m.from && m.from.name) || "",
          to: (m.toAll || []).map(p => p.email), cc: (m.ccAll || []).map(p => p.email),
          subject: m.subject || "", box: f.path, text: m.text || "", peers: [e] });
      }
      const mx = maxUidOf(f.rows);
      if (mx > (Number(next[f.path]) || 0)) next[f.path] = mx;
    }
    r = await H.storeMessages(account.email, rItems);
    stored += r.stored; noText += r.noText; full = full || r.full;
    try { await H.writeRaw(msgBoxKey(account), JSON.stringify(next)); } catch (_) {}
    boxesCaughtUp = !res.folders.some(f => f.truncated || f.skipped);
  }
  return { caughtUp: sentCaughtUp && boxesCaughtUp, stored, noText, full };
}

// 한 사람의 보낸편지함·받은편지함을 잇달아 처리한다 (자동 실행이 쓰는 단위)
// 자동 실행은 **증분 스캔(커서)** 을 켠다. until(절대시각)까지 끝낸다 — 함수 제한시간 60초 안.
async function syncAccount(account, contacted, opts) {
  const o = Object.assign({ useCursor: true }, opts || {});
  const until = Number(o.until) || (Date.now() + 48e3);
  const left = () => until - Date.now();

  // 발송 기록 가져오기(중복 차단용). v2 커서: 보낸편지함 폴더 인식 버그로 예전 커서가 엉뚱한 폴더를
  // 기준으로 앞서 가 있을 수 있어 5월부터 다시 — 오래된 것부터 400통씩 이어서, 일괄 저장.
  const sentRead = await readSent(account, Object.assign({}, o, { cursorKey: "sent2", oldestFirst: true, limit: 400,
    budgetMs: Math.max(3000, Math.min(12000, left() - 20000)) }));
  const sentWrite = await writeSent(account, sentRead.rows);
  // 방금 넣은 발송분도 회신 대조 대상이 되도록 목록을 갱신한다
  sentRead.rows.forEach(r => {
    const k = H.normEmail(r.to);
    if (k && !contacted.has(k)) contacted.set(k, r);
  });

  // 보낸편지함 → 보낸 주소록·'보낸 적 있는 주소'. 따라잡을 때까지 예산을 넉넉히 준다.
  // 다 따라잡기 전엔 회신 판정을 미룬다 — 먼저 하면 아직 안 읽은 발송 상대의 회신이
  // '보낸 기록 없음'으로 넘어가고 커서가 지나가 버린다.
  let st = await scanSentBook(account, Math.max(3000, Math.min(30000, left() - 12000)));
  while (!st.caughtUp && left() > 15000) st = await scanSentBook(account, Math.min(30000, left() - 12000));
  if (!st.caughtUp) {
    await H.saveSyncInfo(account.email, { sentFolder: st.sentFolder, sentCaughtUp: false, waiting: true });
    return {
      user: account.email, sent: sentWrite, sentTo: st,
      replies: { found: 0, duplicate: 0, waiting: true },   // 보낸편지함을 다 읽은 뒤에 판정
      scanned: { sent: sentRead.scanned, inbox: 0 }
    };
  }

  const rep = await collectReplies(account, contacted, Object.assign({}, o, { budgetMs: Math.max(4000, left() - 3000) }));
  // 메일 데이터베이스(본문 저장) — 남은 예산으로 이어서 처리한다
  let msgs = null;
  if (left() > 8000) {
    try { msgs = await storeMessagesPass(account, left() - 3000); } catch (e) { msgs = { error: String((e && e.message) || e) }; }
  }
  const prevInfo = (await H.syncInfo(account.email)) || {};
  await H.saveSyncInfo(account.email, {
    sentFolder: st.sentFolder, sentCaughtUp: true,
    folders: rep.folders, foldersCaughtUp: !(rep.folders || []).some(f => f.truncated || f.skipped),
    found: rep.found, notContacted: rep.notContacted,
    msgsCaughtUp: msgs ? Boolean(msgs.caughtUp) : Boolean(prevInfo.msgsCaughtUp), msgsFull: Boolean(msgs && msgs.full),
    msgsError: msgs && msgs.error || undefined
  });
  return {
    user: account.email,
    sent: sentWrite,
    replies: { found: rep.found, duplicate: rep.duplicate, notContacted: rep.notContacted },
    folders: rep.folders,
    messages: msgs,
    messagesCaughtUp: msgs ? Boolean(msgs.caughtUp) : Boolean(prevInfo.msgsCaughtUp),
    scanned: { sent: sentRead.scanned, inbox: rep.scanned }
  };
}

module.exports = {
  SINCE_DEFAULT, MAX_RECIPIENTS,
  candidates, readSent, writeSent, contactedMap, collectReplies, syncAccount, classify, scanSentBook, bookReady, storeMessagesPass, isInternal
};
