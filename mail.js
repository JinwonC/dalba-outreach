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

// 보낸편지함 이름은 배포·언어 설정마다 다르다(Sent / 보낸메일함 / Sent Messages …).
// IMAP 은 폴더에 용도 플래그(\Sent)를 붙이도록 돼 있으니 그것부터 보고,
// 없을 때만 이름으로 추측한다 — 이름 목록에 의존하면 어느 계정에서 조용히 빈 목록이 된다.
async function findMailbox(client, kind) {
  if (kind === "inbox" || kind === "replies") return "INBOX";
  const boxes = await client.list();
  const flagged = boxes.find(b => b.specialUse === "\\Sent");
  if (flagged) return flagged.path;
  const guess = boxes.find(b => /^(sent|sent items|sent messages|보낸편지함|보낸메일함)$/i.test(b.name || ""));
  return guess ? guess.path : "INBOX";
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
    path = await findMailbox(client, kind);
    const lock = await client.getMailboxLock(path);
    try {
      const uids = await client.search({ since }, { uid: true }) || [];
      total = uids.length;
      const take = uids.slice(-limit);   // 검색 결과는 오름차순이므로 뒤쪽이 최신

      if (take.length) {
        for await (const msg of client.fetch(take, { envelope: true }, { uid: true })) {
          const env = msg.envelope || {};
          rows.push({
            uid: msg.uid,
            messageId: env.messageId || "",
            at: env.date,
            subject: env.subject || "(제목 없음)",
            from: one(env.from),
            to: one(env.to),
            toAll: all(env.to),
            ccAll: all(env.cc)
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
    // 상대가 보낸 것: 받은편지함에서 from=peer
    await collectSide(client, "INBOX", { since, from: peer }, "in", perSide, deadline, out);
    // 담당자가 보낸 것: 보낸편지함에서 to=peer
    const sentPath = await findMailbox(client, "sent");
    await collectSide(client, sentPath, { since, to: peer }, "out", perSide, deadline, out);
  } finally {
    try { await client.logout(); } catch (_) { try { client.close(); } catch (_) {} }
  }
  out.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));   // 대화는 오래된→최신
  return { peer, rows: out };
}

module.exports = { read, readThread, IMAP_HOST, IMAP_PORT };
