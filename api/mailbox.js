// Vercel Serverless Function — 배포 경로: /api/mailbox
//
// 네이버웍스 메일함을 IMAP 으로 읽는다. SMTP 발송에 쓰는 그 **외부 앱 비밀번호**가
// IMAP 에도 그대로 통하므로 새로 등록할 것은 없다.
//
//   GET /api/mailbox?box=sent            → 내가 보낸 메일
//   GET /api/mailbox?box=inbox           → 내가 받은 메일
//   GET /api/mailbox?box=replies         → 받은 메일 중 **아웃리치한 크리에이터의 회신**만
//   GET /api/mailbox?ping=1              → 연결·로그인만 확인 (목록 안 읽음)
//   공통: days(기본 30) · limit(기본 200) · user(관리자만, 다른 담당자 메일함)
//
// ─── 제목·발신자만 읽는다 ────────────────────────────────────────
// 본문은 가져오지 않는다(envelope 만 fetch). 느려지기도 하지만, 무엇보다
// 아웃리치 현황을 보는 데 본문까지 읽을 이유가 없다. 필요 최소한만 본다.
//
// ─── 볼 수 있는 범위 ─────────────────────────────────────────────
// 담당자는 **자기 메일함만** 본다. 다른 사람 메일함은 ADMIN_EMAILS 에 등록된
// 관리자만 user= 로 지정해 볼 수 있다. 남의 받은편지함을 여는 일이므로
// 관리자 판정을 코드에 숨기지 않고 환경변수로 명시하게 했다.
//
// ─── 환경변수 ────────────────────────────────────────────────────
//   NW_IMAP_HOST  기본 imap.worksmobile.com
//   NW_IMAP_PORT  기본 993 (SSL)
//   ADMIN_EMAILS  다른 담당자 메일함을 볼 수 있는 관리자

const { ImapFlow } = require("imapflow");
const A = require("../auth.js");
const H = require("../history.js");

const IMAP_HOST = process.env.NW_IMAP_HOST || "imap.worksmobile.com";
const IMAP_PORT = Number(process.env.NW_IMAP_PORT || 993);

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

const MAX_LIMIT = 500;

function isAdmin(u) {
  return Boolean(u && ADMIN_EMAILS.includes(String(u.email).toLowerCase()));
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

function addr(a) {
  const x = (a && a[0]) || null;
  if (!x) return { name: "", email: "" };
  return { name: x.name || "", email: String(x.address || "").toLowerCase() };
}

function readAll(env, key) {
  return (env[key] || []).map(x => String(x.address || "").toLowerCase()).filter(Boolean);
}

module.exports = async (req, res) => {
  let client = null;
  try {
    res.setHeader("Cache-Control", "no-store");

    if (!A.enabled()) {
      res.status(501).json({ error: "직원 계정(NW_ACCOUNTS)을 설정해야 메일함을 읽을 수 있습니다" });
      return;
    }
    const me = A.currentUser(req);
    if (!me) { res.status(401).json({ error: "로그인이 필요합니다" }); return; }

    const q = req.query || {};

    // 어느 계정의 메일함을 볼 것인가 — 기본은 본인
    let target = me;
    const wanted = String(q.user || "").trim().toLowerCase();
    if (wanted && wanted !== String(me.email).toLowerCase()) {
      if (!isAdmin(me)) { res.status(403).json({ error: "다른 담당자의 메일함은 관리자만 볼 수 있습니다" }); return; }
      target = A.findByEmail(wanted);
      if (!target) { res.status(404).json({ error: "등록되지 않은 담당자입니다: " + wanted }); return; }
    }

    const kind = String(q.box || "sent").toLowerCase();
    const days = Math.max(1, Math.min(Number(q.days) || 30, 365));
    const limit = Math.max(1, Math.min(Number(q.limit) || 200, MAX_LIMIT));
    const since = new Date(Date.now() - days * 86400e3);

    client = new ImapFlow({
      host: IMAP_HOST, port: IMAP_PORT, secure: IMAP_PORT === 993,
      auth: { user: target.email, pass: target.appPassword },
      logger: false,
      // 함수 제한시간(60초) 안에서 끝나야 한다 — 매달리지 않고 일찍 실패시킨다
      socketTimeout: 25000, greetingTimeout: 15000, connectionTimeout: 15000
    });

    try {
      await client.connect();
    } catch (e) {
      res.status(502).json({
        error: "네이버웍스 IMAP 연결/인증 실패: " + String((e && e.message) || e),
        hint: "① 관리자센터에서 IMAP/POP3 사용이 허용됐는지 " +
              "② NW_ACCOUNTS 의 앱 비밀번호가 '설정 > 보안 > 외부 앱 비밀번호' 값인지 " +
              "③ 계정이 " + target.email + " 가 맞는지 확인하세요."
      });
      return;
    }

    if (q.ping === "1") {
      await client.logout();
      res.status(200).json({ ok: true, user: target.email, host: IMAP_HOST });
      return;
    }

    const path = await findMailbox(client, kind);
    const lock = await client.getMailboxLock(path);

    // 회신 보기는 "우리가 접촉한 크리에이터" 목록과 대조한다
    let contacted = null;
    if (kind === "replies") {
      const log = H.enabled() ? await H.recent(H.LOG_MAX) : [];
      contacted = new Map();
      log.forEach(r => {
        const k = H.normEmail(r.to);
        if (k) contacted.set(k, r);
      });
    }

    const rows = [];
    try {
      for await (const msg of client.fetch({ since }, { envelope: true, uid: true })) {
        const env = msg.envelope || {};
        const from = addr(env.from);
        const to = addr(env.to);

        if (kind === "replies") {
          const hit = contacted.get(H.normEmail(from.email));
          if (!hit) continue;
          rows.push({
            uid: msg.uid, at: env.date, subject: env.subject || "(제목 없음)",
            from: from.email, fromName: from.name,
            outreach: { by: hit.by, byName: hit.byName, campaign: hit.campaign, sentAt: hit.at }
          });
        } else {
          rows.push({
            uid: msg.uid, at: env.date, subject: env.subject || "(제목 없음)",
            from: from.email, fromName: from.name,
            to: to.email, toName: to.name,
            recipients: readAll(env, "to").concat(readAll(env, "cc"))
          });
        }
        // 오래된 것부터 오므로, 상한을 넘으면 앞쪽을 버리고 최신을 남긴다
        if (rows.length > limit) rows.shift();
      }
    } finally {
      lock.release();
    }

    await client.logout();
    client = null;

    rows.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    res.status(200).json({
      user: target.email, box: kind, path, days, count: rows.length,
      // 상한에 걸렸는지 알려 준다 — 전부라고 오해하면 판단이 틀어진다
      truncated: rows.length >= limit,
      rows
    });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  } finally {
    if (client) { try { await client.logout(); } catch (_) { try { client.close(); } catch (_) {} } }
  }
};
