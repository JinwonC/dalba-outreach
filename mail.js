// 네이버웍스 메일함 읽기 (IMAP)
//
// api/mailbox.js(조회)와 api/backfill.js(이력 가져오기)가 같은 코드를 쓰도록 여기 모았다.
// 폴더 탐색 규칙이 두 곳에 따로 있으면 한쪽만 고쳐져 조용히 어긋난다.
//
// SMTP 발송에 쓰는 **외부 앱 비밀번호**가 IMAP 에도 그대로 통하므로 따로 등록할 것은 없다.
// 제목·발신자·수신자만 읽는다(envelope). 본문은 가져오지 않는다.

const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");

const IMAP_HOST = process.env.NW_IMAP_HOST || "imap.worksmobile.com";
const IMAP_PORT = Number(process.env.NW_IMAP_PORT || 993);

function makeClient(account) {
  return new ImapFlow({
    host: IMAP_HOST, port: IMAP_PORT, secure: IMAP_PORT === 993,
    auth: { user: account.email, pass: account.appPassword },
    logger: false,
    // 함수 제한시간(60초) 안에서 끝나야 한다 — 매달리지 않고 일찍 실패시킨다
    socketTimeout: 25000, greetingTimeout: 15000, connectionTimeout: 15000
  });
}

// ─── 본문 (데이터베이스 저장용) ───────────────────────────────────
// 메일 원문의 **앞 64KB 만** 받는다(첨부파일까지 내려받지 않도록). 인용된 이전 메일(>, "On … wrote:",
// "-----Original Message-----", "보낸 사람:" …)은 떼고, 길이는 MSG_BODY_MAX_CHARS(기본 4000자)로 자른다.
const BODY_FETCH_BYTES = 65536;
const BODY_MAX = Number(process.env.MSG_BODY_MAX_CHARS) || 4000;
function cleanBody(t) {
  let s = String(t == null ? "" : t).replace(/\r\n/g, "\n");
  const cut = s.search(/\n(On [^\n]{0,200}wrote:|-{2,}\s*Original Message\s*-{2,}|From: [^\n]+\n(Sent|Date): |보낸 사람: |[^\n]{0,80}님이 작성:|20\d\d[^\n]{0,60}(작성|wrote):)/i);
  if (cut > 0) s = s.slice(0, cut);
  s = s.split("\n").filter(l => !/^\s*>/.test(l)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return s.length > BODY_MAX ? s.slice(0, BODY_MAX) + "\n…(이하 생략)" : s;
}
async function bodyOf(source) {
  if (!source) return "";
  try { const p = await simpleParser(source); return cleanBody(p.text || ""); } catch (_) { return ""; }
}

// 보낸편지함 찾기 — 배포·언어 설정마다 이름이 다르다(Sent / Sent Messages / 보낸메일함 / 보낸 메일함 …).
//   ① IMAP 용도 표시(\Sent) → ② 이름(띄어쓰기·변형 허용, 하위 폴더면 끝 이름) →
//   ③ 그래도 없으면 **내용으로**: 폴더마다 최근 메일을 몇 통 보고 '보낸 사람 = 본인' 인 폴더.
// 못 찾으면 받은편지함으로 대신하지 **않는다** — 예전엔 조용히 받은편지함을 읽어 발송이 하나도
// 안 잡혔다. 대신 폴더 목록과 함께 오류를 낸다(무엇이 문제인지 화면에 보이도록).
const SENT_NAME = /^(sent|sent items|sent messages|sent mail|outbox sent|보낸\s*편지함|보낸\s*메일함|보낸\s*메일|보낸함|보낸\s*편지)$/i;
const sentCache = new Map();   // 계정 → 경로 (이 함수 인스턴스 동안)
function leaf(b) { return String(b.name || String(b.path || "").split(b.delimiter || "/").pop() || "").trim(); }
function selectable(b) { return !(b.flags && (b.flags.has ? b.flags.has("\\Noselect") : [].concat(b.flags).includes("\\Noselect"))); }
async function detectSentByContent(client, boxes, me) {
  let best = null;
  for (const b of boxes) {
    if (b.path === "INBOX" || !selectable(b)) continue;
    if (/^(drafts?|임시\s*보관함|trash|휴지통|deleted.*|spam|junk.*|스팸.*)$/i.test(leaf(b))) continue;
    let lock;
    try { lock = await client.getMailboxLock(b.path); } catch (_) { continue; }
    try {
      const n = (client.mailbox && client.mailbox.exists) || 0;
      if (!n) continue;
      let mine = 0, total = 0;
      for await (const msg of client.fetch(Math.max(1, n - 14) + ":*", { envelope: true })) {
        total++;
        const f = ((msg.envelope && msg.envelope.from) || [])[0];
        if (f && String(f.address || "").toLowerCase() === me) mine++;
      }
      const ratio = total ? mine / total : 0;
      if (ratio >= 0.6 && (!best || ratio > best.ratio || (ratio === best.ratio && total > best.total))) best = { path: b.path, ratio, total };
    } catch (_) { /* 읽을 수 없는 폴더는 건너뛴다 */ }
    finally { lock.release(); }
  }
  return best && best.path;
}
async function findMailbox(client, kind, account) {
  if (kind === "inbox" || kind === "replies") return "INBOX";
  const me = String((account && account.email) || "").toLowerCase();
  if (me && sentCache.has(me)) return sentCache.get(me);
  const boxes = await client.list();
  let path = (boxes.find(b => b.specialUse === "\\Sent") || {}).path ||
             (boxes.find(b => SENT_NAME.test(leaf(b))) || {}).path || "";
  if (!path && me) path = await detectSentByContent(client, boxes, me) || "";
  if (!path) {
    const names = boxes.map(b => b.path).join(", ");
    throw new Error("보낸편지함 폴더를 찾지 못했습니다 (폴더: " + names + ")");
  }
  if (me) sentCache.set(me, path);
  return path;
}

function one(list) {
  const x = (list && list[0]) || null;
  return x ? { name: x.name || "", email: String(x.address || "").toLowerCase() } : { name: "", email: "" };
}

function all(list) {
  return (list || []).map(x => ({ name: x.name || "", email: String(x.address || "").toLowerCase() }))
    .filter(x => x.email);
}

// 계정 하나의 메일함을 읽어 최신순 배열로 돌려준다.
async function read(account, opts) {
  const o = opts || {};
  const kind = o.kind || "sent";
  const limit = Math.max(1, Math.min(Number(o.limit) || 200, 20000));
  // since 를 날짜로 직접 줄 수도 있고(고정 시작일), days 로 줄 수도 있다
  const since = o.since ? new Date(o.since)
    : new Date(Date.now() - Math.max(1, Math.min(Number(o.days) || 30, 3650)) * 86400e3);

  const client = makeClient(account);
  await client.connect();

  if (o.pingOnly) { await client.logout(); return { path: "", rows: [], truncated: false }; }

  // ⚠️ 여기서 fetch({since}) 로 곧장 훑으면 **조건에 걸리는 메일을 전부 내려받는다.**
  //    보낸편지함은 수백 통이라 견디지만 받은편지함은 수천 통이라 함수 제한시간을 넘긴다.
  //    그래서 ① 번호(uid)만 먼저 검색해 두고 ② 최신 limit 개만 실제로 받아온다.
  let rows = [];
  let path = "";
  let total = 0;
  const deadline = Date.now() + Math.max(5000, Number(o.budgetMs) || 35000);

  try {
    path = await findMailbox(client, kind, account);
    const lock = await client.getMailboxLock(path);
    try {
      const found = await client.search({ since }, { uid: true }) || [];
      // 증분 스캔: minUid 가 오면 그보다 큰(=이후 도착) 것만 새로 본다. 매 실행 전체를
      // 다시 훑지 않아 예산 안에서 확실히 끝나고, 못 본 것도 커서가 올라가며 결국 다 걸린다.
      // 단, 메일함 UID 가 재설정(UIDVALIDITY 변경)돼 최대 UID 가 커서보다 작아지면
      // 커서를 무시하고 전체를 다시 본다(안 그러면 아무것도 안 잡힌다).
      const fmax = found.length ? Number(found[found.length - 1]) : 0;
      const useMin = o.minUid && fmax >= Number(o.minUid);
      const uids = (useMin ? found.filter(u => Number(u) > Number(o.minUid)) : found);
      total = uids.length;
      // 기본은 최신 limit 통. oldestFirst 면 **오래된 것부터** limit 통 — 커서와 함께 조금씩 이어서
      // 처리할 때 쓴다(최신부터 자르면 커서가 앞질러 가 오래된 메일을 영영 건너뛴다).
      const take = o.oldestFirst ? uids.slice(0, limit) : uids.slice(-limit);   // 오름차순: 뒤쪽이 최신

      if (take.length) {
        const q = o.withBody ? { envelope: true, source: { start: 0, maxLength: BODY_FETCH_BYTES } } : { envelope: true };
        for await (const msg of client.fetch(take, q, { uid: true })) {
          const env = msg.envelope || {};
          rows.push({
            text: o.withBody ? await bodyOf(msg.source) : undefined,
            uid: msg.uid,
            messageId: env.messageId || "",
            at: env.date,
            subject: env.subject || "(제목 없음)",
            from: one(env.from),
            to: one(env.to),
            toAll: all(env.to),
            ccAll: all(env.cc),
            bccAll: all(env.bcc)          // 보낸편지함 사본엔 숨은참조가 남는 경우가 있다
          });
          // 그래도 오래 걸리면 거기까지만 — 통째로 실패하는 것보다 낫다
          if (Date.now() > deadline) break;
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    try { await client.logout(); } catch (_) { try { client.close(); } catch (_) {} }
  }

  rows.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
  // total 은 조건에 걸린 전체 통수. 몇 통 중 몇 통을 봤는지 알려야 "이게 전부" 로 오해하지 않는다
  return { path, rows, total, truncated: total > rows.length };
}

// ─── 대화 한 건을 본문까지 읽는다 ────────────────────────────────
// 관리자가 특정 담당자의 특정 크리에이터(peer)와의 협상 스레드를 볼 때만 쓴다.
// 받은편지함(peer→담당자)과 보낸편지함(담당자→peer)을 합쳐 시간순으로 돌려준다.
// 본문은 여기서만 읽는다 — **저장하지 않고** 매번 그때그때 불러온다(민감 정보 최소화).
function clipBody(t) {
  const s = String(t == null ? "" : t).replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s.length > 8000 ? s.slice(0, 8000) + "\n\n…(이하 생략)" : s;
}

async function collectSide(client, path, crit, direction, limit, deadline, out) {
  if (!path) return;
  let lock;
  try { lock = await client.getMailboxLock(path); } catch (_) { return; }
  try {
    const uids = await client.search(crit, { uid: true }) || [];
    const take = uids.slice(-limit);                    // 오름차순이라 뒤쪽이 최신
    if (!take.length) return;
    for await (const msg of client.fetch(take, { uid: true, envelope: true, source: true }, { uid: true })) {
      const env = msg.envelope || {};
      let text = "";
      try { const parsed = await simpleParser(msg.source); text = parsed.text || ""; } catch (_) {}
      out.push({
        direction,                                      // "in"=상대가 보냄 / "out"=담당자가 보냄
        at: env.date, subject: env.subject || "(제목 없음)",
        from: one(env.from), to: one(env.to),
        body: clipBody(text)
      });
      if (Date.now() > deadline) break;
    }
  } finally { if (lock) lock.release(); }
}

async function readThread(account, opts) {
  const o = opts || {};
  const peer = String(o.peer || "").trim().toLowerCase();
  if (!peer) return { peer: "", rows: [] };
  const since = o.since ? new Date(o.since)
    : new Date(Date.now() - Math.max(1, Math.min(Number(o.days) || 365, 3650)) * 86400e3);
  const perSide = Math.max(1, Math.min(Number(o.limit) || 50, 300));
  const deadline = Date.now() + Math.max(8000, Number(o.budgetMs) || 45000);

  const client = makeClient(account);
  await client.connect();
  const out = [];
  try {
    if (o.pingOnly) return { peer, rows: [] };
    // 담당자가 보낸 것: 보낸편지함에서 to=peer (못 찾으면 그쪽만 건너뛴다 — 대화 보기는 살린다)
    let sentPath = "";
    try { sentPath = await findMailbox(client, "sent", account); } catch (_) { sentPath = ""; }
    // 상대가 보낸 것: 받은편지함 + 사용자 폴더(자동 분류로 옮겨진 회신까지)에서 from=peer
    const boxes = (await client.list()).filter(isReplyFolder).filter(b => b.path !== sentPath);
    boxes.sort((a, b) => (a.path === "INBOX" ? -1 : b.path === "INBOX" ? 1 : 0));
    for (const b of boxes) {
      if (Date.now() > deadline) break;
      try { await collectSide(client, b.path, { since, from: peer }, "in", perSide, deadline, out); } catch (_) {}
    }
    if (sentPath) await collectSide(client, sentPath, { since, to: peer }, "out", perSide, deadline, out);
  } finally {
    try { await client.logout(); } catch (_) { try { client.close(); } catch (_) {} }
  }
  out.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));   // 대화는 오래된→최신
  return { peer, rows: out };
}

// ─── 회신을 찾을 폴더들 ──────────────────────────────────────────
// 회신이 자동 분류 규칙·보관으로 받은편지함 밖(사용자 폴더)에 들어가 있을 수 있다.
// 보낸편지함·임시보관·휴지통·스팸·전체보관(중복)만 빼고 모두 본다.
const SKIP_USE = new Set(["\\Sent", "\\Drafts", "\\Trash", "\\Junk", "\\All", "\\Archive_ALL"]);
const SKIP_NAME = /^(sent|sent items|sent messages|sent mail|보낸편지함|보낸메일함|보낸 편지함|drafts?|임시보관함|임시 보관함|trash|deleted|deleted items|deleted messages|휴지통|spam|junk|junk e-?mail|스팸|스팸편지함|스팸메일함|정크|outbox|보낼편지함|notes|메모)$/i;
function isReplyFolder(b) {
  if (!b || !b.path) return false;
  if (b.flags && (b.flags.has ? b.flags.has("\\Noselect") : [].concat(b.flags).includes("\\Noselect"))) return false;
  if (b.path === "INBOX") return true;
  if (b.specialUse && SKIP_USE.has(b.specialUse)) return false;
  return !SKIP_NAME.test(String(b.name || "").trim());
}

// 여러 폴더를 **한 번의 연결**로 읽는다 (폴더마다 새로 접속하면 느리고 한도에 걸린다).
//   opts.cursors  { 폴더경로: 마지막 처리 UID } — 있으면 그보다 큰 것만 (증분)
//   opts.limit    폴더당 최신 N통, opts.budgetMs 전체 예산
// 반환: { folders:[{ path, name, rows, total, truncated }] } — 예산이 다 되면 남은 폴더는 비어 있다
async function readFolders(account, opts) {
  const o = opts || {};
  const limit = Math.max(1, Math.min(Number(o.limit) || 2000, 20000));
  const since = o.since ? new Date(o.since) : new Date(Date.now() - 30 * 86400e3);
  const cursors = o.cursors || {};
  const deadline = Date.now() + Math.max(5000, Number(o.budgetMs) || 35000);
  const client = makeClient(account);
  await client.connect();
  const out = [];
  try {
    const listed = await client.list();
    // 이름이 특이해서 isReplyFolder 가 못 거른 보낸편지함도 뺀다 (본인이 보낸 메일은 받은 게 아니다)
    let sentPath = "";
    try { sentPath = await findMailbox(client, "sent", account); } catch (_) { sentPath = ""; }
    const boxes = listed.filter(isReplyFolder).filter(b => b.path !== sentPath);
    boxes.sort((a, b) => (a.path === "INBOX" ? -1 : b.path === "INBOX" ? 1 : String(a.path).localeCompare(String(b.path))));
    for (const b of boxes) {
      const entry = { path: b.path, name: b.name || b.path, rows: [], total: 0, truncated: false, skipped: false };
      out.push(entry);
      if (Date.now() > deadline) { entry.skipped = true; continue; }
      let lock;
      try { lock = await client.getMailboxLock(b.path); } catch (_) { entry.skipped = true; continue; }
      try {
        const found = await client.search({ since }, { uid: true }) || [];
        const min = Number(cursors[b.path]) || 0;
        const fmax = found.length ? Number(found[found.length - 1]) : 0;
        const uids = (min && fmax >= min) ? found.filter(u => Number(u) > min) : found;
        entry.total = uids.length;
        const take = uids.slice(-limit);
        if (take.length) {
          const q = o.withBody ? { envelope: true, source: { start: 0, maxLength: BODY_FETCH_BYTES } } : { envelope: true };
          for await (const msg of client.fetch(take, q, { uid: true })) {
            const env = msg.envelope || {};
            entry.rows.push({
              text: o.withBody ? await bodyOf(msg.source) : undefined,
              uid: msg.uid, messageId: env.messageId || "", inReplyTo: env.inReplyTo || "",
              at: env.date, subject: env.subject || "(제목 없음)",
              from: one(env.from), to: one(env.to), toAll: all(env.to), ccAll: all(env.cc), bccAll: all(env.bcc)
            });
            if (Date.now() > deadline) break;
          }
        }
        entry.truncated = entry.total > entry.rows.length;
      } finally { lock.release(); }
    }
  } finally {
    // 로그아웃이 늦어도 기다리지 않는다 (예산 안에 응답하는 게 우선) — 2초 뒤엔 연결을 끊는다
    try { await Promise.race([client.logout(), new Promise(r => setTimeout(r, 2000))]); } catch (_) {}
    try { client.close(); } catch (_) {}
  }
  return { folders: out };
}

module.exports = { read, readFolders, readThread, isReplyFolder, findMailbox, cleanBody, IMAP_HOST, IMAP_PORT };
