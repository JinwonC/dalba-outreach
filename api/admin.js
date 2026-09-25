// Vercel Serverless Function — 배포 경로: /api/admin
//
// 관리자만 볼 수 있는 팀 전체 아웃리치 현황.
//
//   GET /api/admin                     → 요약 + 담당자별 집계
//   GET /api/admin?view=daily&tz=-540  → 일별 발송 건수 (tz 는 브라우저 시차, 분)
//   GET /api/admin?view=sent&by=…      → 발송 이력 (담당자로 거르기)
//   GET /api/admin?view=blocked        → 중복이라 보류된 시도
//   GET /api/admin?view=replies        → 크리에이터 회신 기록
//   GET /api/admin?view=people         → 접촉한 크리에이터 단위로 묶어서
//   공통 파라미터: limit(기본 500), q(주소·이름·핸들·캠페인 검색), days(최근 N일)
//
// ─── 누가 관리자인가 ─────────────────────────────────────────────
// 환경변수 ADMIN_EMAILS 에 적힌 주소만. 예) jinwon.choi@dalba.com,hannie@dalbausa.com
// 비워 두면 **아무도 관리자가 아니다** — 관리자 판정을 코드에 숨겨 두면
// 나중에 이 배포를 보는 사람이 권한 범위를 알 수 없기 때문에, 반드시 명시하게 했다.

const A = require("../auth.js");
const H = require("../history.js");
const IH = require("../inhouse.js");
const { groupPipeline } = require("../pipeline-lib.js");

// 관리자 판정은 auth.js 한 곳에서만 한다 (콤마·세미콜론·공백·줄바꿈 구분 모두 허용)
const isAdmin = A.isAdmin;

// 검색어는 주소·이름·핸들·캠페인·담당자 어디에 걸려도 잡히게 한다.
// 회신 기록은 상대가 to 가 아니라 from 이므로 그쪽도 함께 본다.
function matches(r, q) {
  if (!q) return true;
  const hay = [r.to, r.from, r.name, r.fromName, r.handle, r.subject, r.campaign, r.by, r.byName]
    .filter(Boolean).join(" ").toLowerCase();
  return hay.indexOf(q) >= 0;
}

function withinDays(r, days) {
  if (!days) return true;
  const t = Date.parse(r.at || "");
  if (!isFinite(t)) return true;
  return Date.now() - t <= days * 86400e3;
}

// 크리에이터 한 명당 한 줄로 묶는다 — 같은 사람에게 몇 번 갔는지 한눈에 보이도록
function groupByPerson(sent, blocked) {
  const map = new Map();
  const key = r => H.normEmail(r.to) || H.normHandle(r.handle) || String(r.to || "");

  sent.forEach(r => {
    const k = key(r);
    if (!k) return;
    const cur = map.get(k) || { key: k, to: r.to, name: "", handle: "", sends: [], blocked: 0 };
    if (!cur.name && r.name) cur.name = r.name;
    if (!cur.handle && r.handle) cur.handle = r.handle;
    cur.sends.push({ at: r.at, by: r.by, byName: r.byName, campaign: r.campaign, forced: r.forced });
    map.set(k, cur);
  });

  blocked.forEach(r => {
    const k = key(r);
    if (!k) return;
    const cur = map.get(k) || { key: k, to: r.to, name: r.name || "", handle: r.handle || "", sends: [], blocked: 0 };
    cur.blocked++;
    map.set(k, cur);
  });

  return [...map.values()].map(p => {
    p.sends.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const owners = [...new Set(p.sends.map(s => s.byName || s.by).filter(Boolean))];
    return {
      to: p.to, name: p.name, handle: p.handle,
      count: p.sends.length, blocked: p.blocked,
      owners, lastAt: p.sends[0] ? p.sends[0].at : "",
      lastBy: p.sends[0] ? (p.sends[0].byName || p.sends[0].by) : "",
      lastCampaign: p.sends[0] ? p.sends[0].campaign : "",
      sends: p.sends
    };
  }).sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
}

// 담당자별 "회신한 크리에이터" 목차 — 관리자가 협상 스레드를 열기 위한 목록.
// 회신이 있어야 협상이 성립하므로 회신 기록을 기준으로 담당자→크리에이터로 묶는다.
// 발송 이력에서 그 크리에이터에게 몇 번 보냈는지도 함께 붙인다.
function conversations(sent, replies) {
  const NM = nameByEmail();
  const staff = new Map();
  const ensure = (byKey, byName) => {
    if (!staff.has(byKey)) staff.set(byKey, { by: byKey, byName: byName || byKey, creators: new Map() });
    return staff.get(byKey);
  };
  replies.forEach(r => {
    const byKey = replyStaff(r);          // 회신이 도착한 메일함 주인
    const ck = H.normEmail(r.from);
    if (!byKey || !ck) return;
    const s = ensure(byKey, NM.get(byKey) || r.byName);
    const c = s.creators.get(ck) ||
      { email: r.from, name: r.fromName || "", replies: 0, sent: 0, lastAt: "", lastSubject: "", campaign: r.campaign || "" };
    c.replies++;
    if (r.fromName && !c.name) c.name = r.fromName;
    if (String(r.at || "") > String(c.lastAt || "")) { c.lastAt = r.at || ""; c.lastSubject = r.subject || c.lastSubject; }
    s.creators.set(ck, c);
  });
  sent.forEach(r => {
    const s = staff.get(String(r.by || "").toLowerCase());
    if (!s) return;
    const c = s.creators.get(H.normEmail(r.to));
    if (c) c.sent++;
  });
  return [...staff.values()]
    .map(s => ({ by: s.by, byName: s.byName,
      creators: [...s.creators.values()].sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt))) }))
    .filter(s => s.creators.length)
    .sort((a, b) => b.creators.length - a.creators.length);
}

// 개인 파이프라인 집계는 pipeline-lib.js 로 옮겼다 (발송 화면 api/pipeline.js 와 공유).

// 회신 온 인원 — **관리자 포함 전원**. 회신 로그를 크리에이터(회신 발신 주소) 단위로 묶는다.
// 우리 '회신 인원 데이터베이스' 역할: 누가 회신했는지 · 몇 번 · 마지막 언제 · 누구에게 · 최근 제목.
function repliers(replies, sentAll) {
  const NM = nameByEmail();
  // 발송 로그에서 이메일 → 핸들 (있으면 표·CSV 에 핸들도 채운다)
  const handleOf = new Map();
  for (const s of (sentAll || [])) { const e = H.normEmail(s.to); if (e && s.handle && !handleOf.has(e)) handleOf.set(e, s.handle); }

  const map = new Map();
  for (const r of (replies || [])) {
    const e = H.normEmail(r.from);
    if (!e) continue;
    let a = map.get(e);
    if (!a) { a = { email: r.from, name: r.fromName || "", handle: handleOf.get(e) || "", count: 0, lastAt: "", lastSubject: "", inbox: "", staff: new Map() }; map.set(e, a); }
    a.count++;
    if (!a.name && r.fromName) a.name = r.fromName;
    if (String(r.at || "") >= String(a.lastAt || "")) { a.lastAt = r.at || ""; a.lastSubject = r.subject || a.lastSubject; a.inbox = r.inbox || r.by || a.inbox; }
    const sk = replyStaff(r);            // 회신이 도착한 메일함 주인
    if (sk && !a.staff.has(sk)) a.staff.set(sk, NM.get(sk) || r.byName || sk);
  }
  return [...map.values()].map(a => ({
    email: a.email, name: a.name, handle: a.handle, count: a.count,
    lastAt: a.lastAt, lastSubject: a.lastSubject, inbox: a.inbox,
    staff: [...a.staff.values()]
  })).sort((x, y) => String(y.lastAt).localeCompare(String(x.lastAt)));
}

// 하루 단위 집계.
//
// 기록의 시각은 UTC 다. 한국에서 아침 8시에 보낸 건 UTC 로는 전날 23시라, 그대로
// 자르면 **하루씩 밀린다.** 그래서 브라우저가 보내온 시차(tz, 분 단위)만큼 옮겨서 자른다.
function dayKey(at, tzMin) {
  const t = Date.parse(at || "");
  if (!isFinite(t)) return "";
  return new Date(t - tzMin * 60000).toISOString().slice(0, 10);
}

// 발송이 없던 날도 0 으로 채운다. 빈 날을 빼면 막대가 다닥다닥 붙어
// "매일 꾸준히 보낸 것" 처럼 보인다 — 시간축이 거짓말을 하게 된다.
function fillDays(map, days, tzMin, maxFill) {
  const keys = [...map.keys()].sort();
  if (!keys.length) return [];

  const today = dayKey(new Date().toISOString(), tzMin);
  const span = Math.min(days || 3650, maxFill);
  const startMs = Date.parse(today + "T00:00:00Z") - (span - 1) * 86400e3;
  const firstMs = Math.max(Date.parse(keys[0] + "T00:00:00Z"), startMs);

  const out = [];
  for (let ms = firstMs; ms <= Date.parse(today + "T00:00:00Z"); ms += 86400e3) {
    const k = new Date(ms).toISOString().slice(0, 10);
    out.push(map.get(k) || { date: k, sent: 0, blocked: 0, replied: 0, by: {} });
  }
  return out;
}

function daily(sent, blocked, replies, tzMin, days) {
  const m = new Map();
  const touch = k => {
    let cur = m.get(k);
    if (!cur) { cur = { date: k, sent: 0, blocked: 0, replied: 0, by: {} }; m.set(k, cur); }
    return cur;
  };

  sent.forEach(r => {
    const k = dayKey(r.at, tzMin);
    if (!k) return;
    const cur = touch(k);
    cur.sent++;
    const who = r.byName || r.by || "(알 수 없음)";
    cur.by[who] = (cur.by[who] || 0) + 1;
  });
  blocked.forEach(r => {
    const k = dayKey(r.at, tzMin);
    if (k) touch(k).blocked++;
  });
  // 회신은 **받은 날**에 센다 — 언제 보냈는지가 아니라 언제 답이 왔는지가 궁금한 것이다
  replies.forEach(r => {
    const k = dayKey(r.at, tzMin);
    if (k) touch(k).replied++;
  });

  return fillDays(m, days, tzMin, 180);
}

// ─── 주차별 집계 ─────────────────────────────────────────────────
// 담당자 한 명당 한 줄, 주(월~일)마다 아웃리치 수·회신 수. 일별과 같은 이유로 tz 로 보정한다
// (한국 아침 발송이 UTC 로 전날이라 주가 밀리지 않게). 주 시작은 월요일, ISO 주차로 라벨을 단다.
function localMonday(at, tzMin) {
  const t = Date.parse(at || "");
  if (!isFinite(t)) return null;
  const d = new Date(t - tzMin * 60000);
  const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  u.setUTCDate(u.getUTCDate() - ((u.getUTCDay() + 6) % 7));   // 그 주의 월요일
  return u.toISOString().slice(0, 10);
}
function isoWeekOf(mondayKey) {
  const th = new Date(mondayKey + "T00:00:00Z");
  th.setUTCDate(th.getUTCDate() + 3);                          // 그 주 목요일이 주차를 정한다
  const yStart = new Date(Date.UTC(th.getUTCFullYear(), 0, 1));
  const week = 1 + Math.round(((th - yStart) / 86400000 - 3 + ((yStart.getUTCDay() + 6) % 7)) / 7);
  return { year: th.getUTCFullYear(), week };
}
function addDaysKey(key, n) {
  const t = new Date(key + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

function weekly(sent, replies, tzMin, numWeeks) {
  // 오늘(로컬) 기준 최근 numWeeks 주 — 최신 주가 앞에 오도록
  const todayMon = localMonday(new Date().toISOString(), tzMin);
  const weeks = [];
  const inWindow = new Set();
  for (let i = 0, key = todayMon; i < numWeeks; i++, key = addDaysKey(key, -7)) {
    const w = isoWeekOf(key);
    weeks.push({ key, week: w.week, year: w.year, start: key, end: addDaysKey(key, 6) });
    inWindow.add(key);
  }

  const blank = () => { const c = {}; weeks.forEach(w => { c[w.key] = { sent: 0, replied: 0 }; }); return c; };
  const rows = new Map();
  // 등록된 직원(관리자 포함 전원)은 0건이어도 줄을 만든다 — 누가 안 움직였는지도 현황이다
  roster().forEach(a => rows.set(String(a.email).toLowerCase(),
    { email: a.email, name: a.name, cells: blank(), totalSent: 0, totalReplied: 0 }));
  const ensure = (by, byName) => {
    const k = String(by || "").toLowerCase() || "(알 수 없음)";
    if (!rows.has(k)) rows.set(k, { email: by || k, name: byName || k, cells: blank(), totalSent: 0, totalReplied: 0 });
    return rows.get(k);
  };

  sent.forEach(r => {
    const mk = localMonday(r.at, tzMin);
    if (!mk || !inWindow.has(mk)) return;
    const row = ensure(r.by, r.byName); row.cells[mk].sent++; row.totalSent++;
  });
  // 회신은 **받은 날**이 속한 주에 센다 (통수 기준). 담당자는 그 회신이 도착한 메일함 주인.
  replies.forEach(r => {
    const mk = localMonday(r.at, tzMin);
    if (!mk || !inWindow.has(mk)) return;
    const row = ensure(replyStaff(r), r.byName); row.cells[mk].replied++; row.totalReplied++;
  });

  const list = [...rows.values()]
    .sort((a, b) => b.totalSent - a.totalSent || String(a.name).localeCompare(String(b.name)));
  return { weeks, rows: list };
}

// 담당자 목록은 **등록된 직원 명단(NW_ACCOUNTS)** 에서 시작한다.
// 발송 기록에서만 뽑으면 아직 이 도구로 안 보낸 사람이 목록에 없고, 그러면
// 그 사람의 지난 발송을 가져오려 해도 고를 수가 없다 — 순환에 걸린다.
// 관리자도 아웃리치를 보내므로 **전원 포함**한다 — 관리자 제외 룰은 없앴다
// (담당자 선택칸·0건 행·집계에 관리자도 똑같이 나온다).
function roster() {
  return A.parseAccounts().map(a => ({
    email: a.email,
    name: a.name || a.email.split("@")[0],
    title: a.title || ""
  }));
}

// 이메일 → 담당자 이름. 회신 귀속을 메일함 주인(inbox)으로 옮길 때, 지난 기록의
// byName 이 (옛 전역-귀속 탓에) 다른 담당자 이름이라도 올바른 이름을 붙이려고 쓴다.
function nameByEmail() {
  const m = new Map();
  roster().forEach(a => m.set(String(a.email || "").toLowerCase(), a.name));
  return m;
}

// 회신의 담당자 = **그 회신이 도착한 메일함 주인(inbox)**. 옛 기록은 by 가 엉뚱한
// 담당자일 수 있으나 inbox 는 항상 정확하므로, 어디서든 inbox 를 우선한다.
function replyStaff(r) {
  return String((r && (r.inbox || r.by)) || "").toLowerCase();
}

function summarize(sent, blocked, replies) {
  const byPerson = new Map();
  // 아직 한 건도 안 보낸 담당자도 0 으로 보여준다 — 누가 놀고 있는지도 현황이다
  roster().forEach(a => byPerson.set(a.email, {
    email: a.email, name: a.name, sent: 0, blocked: 0, replied: 0, lastAt: ""
  }));
  sent.forEach(r => {
    const k = r.by || "(알 수 없음)";
    const cur = byPerson.get(k) || { email: k, name: r.byName || "", sent: 0, blocked: 0, replied: 0, lastAt: "" };
    cur.sent++;
    if (!cur.name && r.byName) cur.name = r.byName;
    if (String(r.at || "") > cur.lastAt) cur.lastAt = r.at || "";
    byPerson.set(k, cur);
  });
  blocked.forEach(r => {
    const k = r.by || "(알 수 없음)";
    const cur = byPerson.get(k) || { email: k, name: r.byName || "", sent: 0, blocked: 0, replied: 0, lastAt: "" };
    cur.blocked++;
    byPerson.set(k, cur);
  });

  // 회신은 **보낸 사람** 앞으로 단다 — 누구의 아웃리치가 답을 받았는지가 성과다.
  //
  // 세는 단위는 "답장한 크리에이터 수" 다. 답장 통수로 세면 한 사람이 세 번 답할 때
  // 3건이 되어 **회신율이 100%를 넘는다.** 회신율은 "보낸 사람 중 몇 명이 답했나" 이므로
  // 사람 단위로 세야 말이 된다. (그날 몇 통 왔는지는 일별 화면이 통수로 보여준다)
  const repliedBy = new Map();   // 담당자 → 답장한 크리에이터 집합
  replies.forEach(r => {
    const k = replyStaff(r) || "(알 수 없음)";   // 회신이 도착한 메일함 주인
    const who = H.normEmail(r.from);
    if (!who) return;
    if (!repliedBy.has(k)) repliedBy.set(k, new Set());
    repliedBy.get(k).add(who);
  });
  repliedBy.forEach((set, k) => {
    const cur = byPerson.get(k) || { email: k, name: "", sent: 0, blocked: 0, replied: 0, lastAt: "" };
    cur.replied = set.size;
    byPerson.set(k, cur);
  });

  const uniq = new Set(sent.map(r => H.normEmail(r.to)).filter(Boolean));
  const repliedPeople = new Set(replies.map(r => H.normEmail(r.from)).filter(Boolean));
  return {
    totals: {
      sent: sent.length, people: uniq.size, blocked: blocked.length,
      replied: repliedPeople.size,      // 답장한 크리에이터 수 (회신율의 분자)
      replyMessages: replies.length     // 받은 답장 통수 — 참고용
    },
    // 많이 보낸 순, 같으면 이름순 — 0건인 사람은 자연히 아래로 모인다
    staff: [...byPerson.values()].sort((a, b) => b.sent - a.sent || String(a.name).localeCompare(String(b.name)))
  };
}

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    const me = A.enabled() ? A.currentUser(req) : null;
    if (A.enabled() && !me) { res.status(401).json({ error: "로그인이 필요합니다" }); return; }

    // 직원 계정을 안 쓰는 배포에서는 관리자를 특정할 수 없다 — 기능을 닫는다
    if (!A.enabled()) {
      res.status(501).json({ error: "직원 계정(NW_ACCOUNTS)을 설정해야 관리자 화면을 쓸 수 있습니다" });
      return;
    }
    if (!A.adminEmails().length) {
      res.status(501).json({ error: "환경변수 ADMIN_EMAILS 에 관리자 이메일을 등록하세요 (예: jinwon.choi@dalba.com)" });
      return;
    }
    if (!isAdmin(me)) { res.status(403).json({ error: "관리자만 볼 수 있습니다" }); return; }

    if (!H.enabled()) {
      // 화면이 "누가 로그인했는지" 는 계속 보여줄 수 있어야 하므로 me 도 함께 준다
      res.status(200).json({
        historyEnabled: false,
        me: A.publicUser(me),
        error: "발송 이력 저장소가 연결되지 않아 보여줄 기록이 없습니다 (Vercel → Storage → Upstash Redis)"
      });
      return;
    }

    const meEmail = String((me && me.email) || "").toLowerCase();

    // ─── POST: 중복 시도 승인 ────────────────────────────────────
    // 관리자가 막힌 담당자에게 그 크리에이터 발송을 허가한다. 이후 그 담당자가
    // 자기 계정으로 다시 보내면 통과한다 (관리자가 대신 보내는 강제 발송과 다름).
    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = {}; } }
      body = body || {};
      if (body.action === "approve") {
        const items = Array.isArray(body.items) ? body.items : [];
        const admins = A.adminEmails();
        let done = 0, skipped = 0;
        for (const it of items) {
          const staff = String((it && it.by) || "").toLowerCase();
          const to = String((it && it.to) || "");
          const handle = (it && it.handle) || "";
          // 담당자 이메일 + 크리에이터 식별자가 있어야 하고, 관리자에게 주는 승인은 의미 없다
          if (!staff || admins.includes(staff) || (!to && !handle)) { skipped++; continue; }
          const rv = await H.approveSend({ to, handle, creatorName: it.name }, staff, { approvedBy: meEmail });
          if (rv && rv.approved) done++; else skipped++;
        }
        res.status(200).json({ approved: done, skipped });
        return;
      }
      res.status(400).json({ error: "알 수 없는 요청입니다" });
      return;
    }

    const q = req.query || {};
    const view = String(q.view || "summary");
    const t0 = Date.now();   // 요청 시작 — 무거운 보완 작업은 남은 시간을 보고 건너뛴다
    const displayLimit = Math.max(1, Math.min(Number(q.limit) || 1000, H.LOG_MAX));
    const days = Number(q.days) || 0;
    const needle = String(q.q || "").trim().toLowerCase();
    const by = String(q.by || "").trim().toLowerCase();

    // 집계(요약·담당자별·일별)는 전부 읽어야 정확하다 — 일부만 읽으면 건수가 실제보다 적게 잡힌다.
    // 목록 뷰(발송 이력·중복·회신)만 표시 개수로 제한한다. 읽기는 청크라 실제 데이터만큼만 받는다.
    const countView = view === "summary" || view === "daily" || view === "weekly" || view === "people" || view === "conversations" || view === "pipeline" || view === "repliers" || view === "book";
    const readN = countView ? H.LOG_MAX : displayLimit;

    let cronStatus = null;
    try { cronStatus = JSON.parse(await H.readRaw("outreach:cron:status")); } catch (_) {}

    const [sentAll, blockedAll, replyAll, totalSent, totalBlocked, totalReplies] = await Promise.all([
      // 중복 시도 화면은 '그 크리에이터에게 간 발송을 전부' 보여줘야 하므로 발송 로그를 전량 읽는다
      H.recent(view === "blocked" ? H.LOG_MAX : readN),
      H.recentBlocked(Math.min(readN, H.BLOCK_MAX)),
      H.recentReplies(view === "blocked" || view === "repliers" ? H.REPLY_MAX : Math.min(readN, H.REPLY_MAX)),
      H.count(H.LOG_KEY),
      H.count(H.BLOCK_KEY),
      H.count(H.REPLY_KEY)
    ]);

    // 관리자도 아웃리치를 보내므로 **전원 포함**한다 — 관리자 제외 룰은 없앴다.
    // (기간·검색어·담당자 선택만 반영한다)
    const keep = r => withinDays(r, days) && matches(r, needle) &&
      (!by || String(r.by || "").toLowerCase() === by);

    // 저장된 순서에 기대지 않고 항상 시각순으로 정렬한다.
    // 보낸편지함에서 가져온 기록은 실제 발송 시각이 제각각이라 삽입 순서와 어긋난다.
    const byTime = (a, b) => String(b.at || "").localeCompare(String(a.at || ""));
    const sent = sentAll.filter(keep).sort(byTime);
    const blocked = blockedAll.filter(keep).sort(byTime);
    const replies = replyAll.filter(keep).sort(byTime);

    const base = {
      historyEnabled: true,
      windowDays: H.WINDOW_DAYS,
      me: A.publicUser(me),
      // 등록된 직원 명단. 어느 탭에서 시작하든 담당자 선택칸이 채워져 있어야 한다
      accounts: roster(),
      // 대화(본문)를 열 수 없는 메일함 — 관리자 메일함(본인 제외). 화면은 이 메일함에 대화 링크를 두지 않는다
      hiddenMailboxes: A.adminEmails().filter(e => e !== meEmail),
      // 자동 동기화가 언제 돌았는지 — 숫자가 낡았는지 화면에서 바로 알 수 있어야 한다
      cron: cronStatus,
      // 저장소에 실제로 쌓인 전체 건수 (LLEN — 표시 개수·필터와 무관하게 항상 정확하다)
      stored: { sent: totalSent, blocked: totalBlocked, replies: totalReplies },
      // 목록 뷰에서 표시 상한에 걸렸으면 숨기지 않고 알린다 (집계 뷰는 전부 읽으므로 해당 없음)
      truncated: !countView && sentAll.length >= displayLimit
    };

    if (view === "daily") {
      // tz 는 브라우저의 getTimezoneOffset() (KST 는 -540). 없으면 UTC 기준이 된다.
      const tzMin = Number.isFinite(Number(q.tz)) ? Number(q.tz) : 0;
      res.status(200).json(Object.assign(base, {
        rows: daily(sent, blocked, replies, tzMin, days),
        staff: [...new Set(sent.map(r => r.byName || r.by).filter(Boolean))]
      }));
      return;
    }
    if (view === "weekly") {
      const tzMin = Number.isFinite(Number(q.tz)) ? Number(q.tz) : 0;
      const numWeeks = Math.max(1, Math.min(Number(q.weeks) || 8, 26));
      res.status(200).json(Object.assign(base, weekly(sent, replies, tzMin, numWeeks)));
      return;
    }
    if (view === "sent") { res.status(200).json(Object.assign(base, { rows: sent })); return; }
    if (view === "approvals") {
      // 관리자 승인 내역 (엑셀 내보내기용): 누구를(담당자) · 크리에이터 이메일·핸들 · 승인일 · 승인한 관리자
      const nameMap = new Map(A.parseAccounts().map(a => [String(a.email || "").toLowerCase(), a.name || ""]));
      const list = (await H.allApprovals()).map(a => ({
        by: a.by || "", byName: nameMap.get(String(a.by || "").toLowerCase()) || "",
        to: a.to || "", handle: a.handle || "", name: a.name || "",
        at: a.at || "", approvedBy: a.approvedBy || ""
      })).sort((x, y) => String(y.at).localeCompare(String(x.at)));
      res.status(200).json(Object.assign(base, { rows: list }));
      return;
    }
    if (view === "blocked") {
      // ── 같은 담당자의 같은 크리에이터 반복 시도는 한 줄로 (최신 시도 + 횟수) ──
      const tRead = Date.now() - t0;
      const seenAttempt = new Map();
      const blockedRows = [];
      for (const b of blocked) {           // blocked 는 최신순
        const k = H.normEmail(b.by) + "|" + (H.normEmail(b.to) || H.normHandle(b.handle));
        const hit = seenAttempt.get(k);
        if (hit) { hit.attempts++; continue; }
        const row = Object.assign({}, b, { attempts: 1 });
        seenAttempt.set(k, row); blockedRows.push(row);
      }
      // ── 무거운 조회는 **동시에**, 각각 시간 제한 — 하나가 느려도 화면 전체가 멈추지 않게 ──
      const withTimeout = (p, ms, fallback) => Promise.race([Promise.resolve(p).catch(() => fallback), new Promise(r => setTimeout(() => r(fallback), ms))]);
      const REAPPROVE_DAYS = Math.max(1, Number(process.env.BLOCKED_REAPPROVE_DAYS) || 15);
      const accts = A.parseAccounts().map(a => H.normEmail(a.email));
      const bEmails = blockedRows.map(r => H.normEmail(r.to)).filter(Boolean);
      const room = Math.max(0, 45e3 - (Date.now() - t0));   // 남은 시간
      const tHeavy = Date.now();
      const [appr, ihMatchRaw, books, links] = await Promise.all([
        withTimeout(H.approvalsIndex(), Math.min(8000, room), new Set()),
        withTimeout(IH.matcher(), Math.min(8000, room), null),
        room > 5000 ? withTimeout(Promise.all([H.bookGetMany("sent", accts, bEmails), H.bookGetMany("recv", accts, bEmails)]), Math.min(12000, room), null) : null,
        // 이메일↔핸들 연결(브리지) — 핸들 없이 시도된 건에 크리에이터 핸들을 채운다
        withTimeout(H.bridge(blockedRows), Math.min(6000, room), null)
      ]);
      const ihMatch = ihMatchRaw || (() => null);
      const [bookSent, bookRecv] = books || [new Map(), new Map()];
      const partial = { inhouse: !ihMatchRaw, mailbox: !books };
      const tHeavyMs = Date.now() - tHeavy;
      // 인하우스 협업 크리에이터 — 위에서 불러 둔 ihMatch 로 🤝 표시 (핸들·이메일 대조, 실패해도 화면은 살린다)
      const e2h = new Map();
      for (const s of sentAll) {
        const e = s && H.normEmail(s.to), h = s && H.normHandle(s.handle);
        if (e && h) { const a = e2h.get(e) || new Set(); a.add(h); e2h.set(e, a); }
      }
      // 그 크리에이터에게 간 **모든 발송**을 이메일·핸들로 모은다 (2번 이상이면 전부 보여주려고).
      const byE = new Map(), byH = new Map();
      for (const s of sentAll) {
        if (!s) continue;
        const rec = { by: s.by || "", byName: s.byName || s.by || "", at: s.at || "", campaign: s.campaign || "", forced: Boolean(s.forced) };
        const e = H.normEmail(s.to), h = H.normHandle(s.handle);
        if (e) { const a = byE.get(e) || []; a.push(rec); byE.set(e, a); }
        if (h) { const a = byH.get(h) || []; a.push(rec); byH.set(h, a); }
      }
      const originsOf = r => {
        const e = H.normEmail(r.to), h = H.normHandle(r.handle);
        const seen = new Set(), out = [];
        const add = arr => (arr || []).forEach(x => {
          const k = String(x.by).toLowerCase() + "|" + String(x.at) + "|" + String(x.campaign);
          if (seen.has(k)) return; seen.add(k); out.push(x);
        });
        add(e && byE.get(e)); add(h && byH.get(h));
        out.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));  // 오래된 순
        return out;
      };
      // 크리에이터 → 회신 색인 (누가 회신을 받았는지 · 어떤 제목인지). inbox = 회신이 들어온 메일함.
      // 담당자 귀속은 메일함 주인(inbox) 기준 — 옛 기록의 by 가 다른 담당자여도 바로잡는다.
      const NMb = nameByEmail();
      const qE = new Map(), qH = new Map();
      for (const rp of replyAll) {
        if (!rp) continue;
        const owner = replyStaff(rp);
        const rec = { by: owner, byName: NMb.get(owner) || rp.byName || owner, inbox: rp.inbox || rp.by || "", at: rp.at || "", subject: rp.subject || "" };
        const e = H.normEmail(rp.from), h = H.normHandle(rp.handle);
        if (e) { const a = qE.get(e) || []; a.push(rec); qE.set(e, a); }
        if (h) { const a = qH.get(h) || []; a.push(rec); qH.set(h, a); }
      }
      const repliesOf = r => {
        const e = H.normEmail(r.to), h = H.normHandle(r.handle);
        const seen = new Set(), out = [];
        const add = arr => (arr || []).forEach(x => {
          const k = String(x.inbox).toLowerCase() + "|" + String(x.at) + "|" + String(x.subject);
          if (seen.has(k)) return; seen.add(k); out.push(x);
        });
        add(e && qE.get(e)); add(h && qH.get(h));
        out.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
        return out;
      };
      // ── 승인 판단용 ──
      // 네이버웍스에서 직접 보낸 발송(단체·숨은참조 포함)과 메일함으로 들어온 회신까지 모든 담당자
      // 메일함의 주소록(bookSent/bookRecv, 위에서 동시에 불러 둠)에서 함께 본다. 판정:
      //   replied  회신이 온 크리에이터 → 승인하지 않음 (빨강)
      //   recent   우리 쪽 마지막 발송이 REAPPROVE_DAYS(기본 15일) 안 → 보내지 않음
      //   ok       마지막 발송이 그보다 오래됨 → 다시 보내도 됨 (파랑)
      const blockedIdx = new Map(blockedRows.map((r, i) => [r, i]));
      const rows = blockedRows.map(r => {
        const origins = originsOf(r);
        const e = H.normEmail(r.to);
        // 메일함 발송(웹메일·단체·숨은참조) — 같은 담당자의 툴 발송 기록이 없을 때만 더한다
        (bookSent.get(e) || []).forEach(b => {
          if (origins.some(o => H.normEmail(o.by) === b.owner)) return;
          origins.push({ by: b.owner, byName: NMb.get(b.owner) || b.owner, at: b.last || b.first || "", campaign: "", mailbox: true, n: Number(b.n) || 1 });
        });
        // 원래 발송이 하나도 안 잡혔으면(스냅샷도 없으면) 저장돼 있던 prior 라도 쓴다
        let prior = r.prior;
        if (!origins.length && prior && (prior.byName || prior.by)) origins.push({ by: prior.by || "", byName: prior.byName || prior.by || "", at: prior.at || "", campaign: prior.campaign || "" });
        origins.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
        const reps = repliesOf(r);
        // 메일함으로 들어온 메일(주소록) — 회신 기록에 없는 담당자 메일함이면 더한다
        (bookRecv.get(e) || []).forEach(b => {
          if (reps.some(x => H.normEmail(x.inbox || x.by) === b.owner)) return;
          reps.push({ by: b.owner, byName: NMb.get(b.owner) || b.owner, inbox: b.owner, at: b.last || "", subject: "", mailbox: true, n: Number(b.n) || 1 });
        });
        const lastSentAt = origins.map(o => o.at).filter(Boolean).sort().pop() || (prior && prior.at) || "";
        const t = Date.parse(lastSentAt);
        const daysSinceSent = isFinite(t) ? Math.floor((Date.now() - t) / 86400e3) : null;
        const decision = reps.length ? "replied" : daysSinceSent == null ? "unknown" : daysSinceSent < REAPPROVE_DAYS ? "recent" : "ok";
        const ih = ihMatch(r, [...(e2h.get(H.normEmail(r.to)) || [])]);
        return Object.assign({}, r, {
          // 응답 크기를 줄이려고 최근 20건씩만 싣는다 (전체 건수는 따로)
          origins: origins.slice(-20), originsTotal: origins.length,
          lastSentAt, daysSinceSent, decision,
          replies: reps.slice(-20), repliesTotal: reps.length,
          prior: prior || (origins[0] || null),
          approved: H.approvalFieldsOf({ to: r.to, handle: r.handle }, r.by).some(f => appr.has(f)),
          inhouse: Boolean(ih), inhouseHandle: ih ? ih.handle : "", inhouseVia: ih ? ih.via : "",
          // 크리에이터 핸들: 시도에 적힌 것 → 없으면 발송 기록의 같은 이메일 → 저장된 이메일↔핸들 연결
          handle: H.normHandle(r.handle) || [...(e2h.get(H.normEmail(r.to)) || [])][0] ||
            ((links && links[blockedIdx.get(r)] && links[blockedIdx.get(r)].handles[0]) || ""),
          handleLinked: !H.normHandle(r.handle) && Boolean([...(e2h.get(H.normEmail(r.to)) || [])][0] || (links && links[blockedIdx.get(r)] && links[blockedIdx.get(r)].handles[0]))
        });
      });
      res.status(200).json(Object.assign(base, { rows, reapproveDays: REAPPROVE_DAYS, partial,
        timing: { readMs: tRead, heavyMs: tHeavyMs, totalMs: Date.now() - t0 } }));
      return;
    }
    if (view === "people") {
      res.status(200).json(Object.assign(base, { rows: groupByPerson(sent, blocked) }));
      return;
    }

    if (view === "replies") { res.status(200).json(Object.assign(base, { rows: replies })); return; }
    if (view === "conversations") {
      // 관리자 메일함의 대화는 목록에도 올리지 않는다 (본인 것만 예외)
      const rows = conversations(sent, replies).filter(g => A.canViewMailbox(me, g.by));
      res.status(200).json(Object.assign(base, { rows }));
      return;
    }
    // ─── 📒 주소록 — 담당자별 보낸/받은 외부 주소 (관리자 전용 · 제목·주소만, 본문 없음) ───
    //   dir=sent  보낸 주소: 메일함 보낸편지함(단체·참조·숨은참조 포함) + 이 툴로 보낸 기록
    //   dir=recv  받은 주소: 받은편지함·사용자 폴더의 회사 밖 발신자 전부 (+ 우리가 보낸 적 있는지)
    // 주소록엔 **내용을 싣지 않는다** — 제목(subj)은 저장은 하되 이 화면·응답에서는 뺀다.
    //   dir=replied  회신 온 사람: 담당자 메일함으로 메일이 온 사람 중 우리가 보낸 적 있는 주소
    //                (받은 주소록 + 회신 기록으로 보완 — 주소록을 채우는 중에도 바로 보이도록)
    if (view === "book") {
      const dir = q.dir === "recv" ? "recv" : q.dir === "replied" ? "replied" : "sent";
      const NM = nameByEmail();
      const staffList = by ? [by] : roster().map(a => String(a.email).toLowerCase());
      const contactedAll = new Set(sentAll.map(r => H.normEmail(r.to)).filter(Boolean));
      // 이메일 → 핸들 (발송 기록에서) — 받은 쪽에도 핸들을 붙여 준다
      const handleOf = new Map();
      sentAll.forEach(r => { const e = H.normEmail(r.to), h = H.normHandle(r.handle); if (e && h && !handleOf.has(e)) handleOf.set(e, h); });
      const rows = [];
      for (const st of staffList) {
        const book = await H.bookAll(dir === "sent" ? "sent" : "recv", st);
        const map = new Map();
        book.forEach(b => map.set(b.email, Object.assign({ staff: st, staffName: NM.get(st) || st, src: ["mailbox"] }, b)));
        if (dir === "sent") {
          // 이 툴로 보낸 메일은 SMTP 로 나가 보낸편지함에 없을 수 있다 → 발송 기록에서 더한다.
          // 보낸편지함에서 가져온 기록(source:"imap")은 이미 메일함 주소록에 세어져 있으니 뺀다.
          // 주소록이 아직 비어 있는(채우는 중인) 주소는 예전에 보낸편지함에서 가져온 기록(imap)으로 보완한다.
          const inBook = new Set(map.keys());
          sentAll.forEach(r => {
            if (H.normEmail(r.by) !== st) return;
            const e = H.normEmail(r.to);
            if (!e) return;
            const imap = r.source === "imap";
            if (imap && inBook.has(e)) return;
            let x = map.get(e);
            if (!x) { x = { email: e, staff: st, staffName: NM.get(st) || st, n: 0, first: "", last: "", subj: "", name: "", src: [] }; map.set(e, x); }
            x.n = (Number(x.n) || 0) + 1;
            const at = String(r.at || "");
            if (at && (!x.first || at < x.first)) x.first = at;
            if (at >= String(x.last || "")) { x.last = at; x.subj = r.campaign || x.subj; }
            if (!x.name && r.name) x.name = r.name;
            if (!x.handle && r.handle) x.handle = H.normHandle(r.handle);
            const tag = imap ? "mailbox" : "tool";
            if (x.src.indexOf(tag) < 0) x.src.push(tag);
          });
        } else {
          const sentTo = await H.sentToSet(st);
          map.forEach(x => { x.emailed = sentTo.has(x.email) || contactedAll.has(x.email); if (!x.handle && handleOf.has(x.email)) x.handle = handleOf.get(x.email); });
          if (dir === "replied") {
            // 받은 주소록이 아직 덜 채워졌어도 회신 기록에 있는 사람은 바로 보이게 보완한다
            replyAll.forEach(r => {
              if (replyStaff(r) !== st) return;
              const e = H.normEmail(r.from);
              if (!e) return;
              let x = map.get(e);
              if (!x) { x = { email: e, staff: st, staffName: NM.get(st) || st, n: 0, first: "", last: "", name: r.fromName || "", box: r.box || "", src: ["log"], fromLog: 0 }; map.set(e, x); }
              x.emailed = true;
              if (x.src && x.src[0] === "log") {
                x.n++;
                const at = String(r.at || "");
                if (at && (!x.first || at < x.first)) x.first = at;
                if (at >= String(x.last || "")) { x.last = at; if (r.box) x.box = r.box; }
              }
              if (!x.handle && handleOf.has(e)) x.handle = handleOf.get(e);
            });
            [...map.keys()].forEach(k => { if (!map.get(k).emailed) map.delete(k); });
          }
        }
        map.forEach(x => rows.push(x));
      }
      const kept = rows.filter(x => withinDays({ at: x.last }, days) &&
        (!needle || [x.email, x.name, x.handle, x.box].filter(Boolean).join(" ").toLowerCase().indexOf(needle) >= 0))
        .sort((a, b) => String(b.last || "").localeCompare(String(a.last || "")))
        .map(x => { const o = Object.assign({}, x); delete o.subj; delete o.fromLog; return o; });   // 내용(제목)은 싣지 않는다
      // 담당자별 채움 상태 — 어느 폴더를 보낸편지함으로 읽었는지 · 주소 수 · 마지막 동기화 · 오류
      const status = [];
      for (const st of staffList) {
        const [sn, rn, mn, info] = await Promise.all([H.bookCount("sent", st), H.bookCount("recv", st), H.messageCount(st), H.syncInfo(st)]);
        status.push(Object.assign({ staff: st, staffName: NM.get(st) || st, sentBook: sn, recvBook: rn, messages: mn }, info || {}));
      }
      const msgUsage = await H.messageUsage();   // 메일 데이터베이스 용량 (본문 저장)
      res.status(200).json(Object.assign(base, { dir, rows: kept, status, msgUsage }));
      return;
    }
    if (view === "repliers") {
      // 담당자(by) 를 고르면 **그 담당자가 발송해서 회신 온 크리에이터만** 보여준다
      //   = 그 담당자 메일함(inbox)에 도착한 회신 (replyStaff). 안 고르면 관리자 포함 전원.
      const kept = replyAll.filter(r => withinDays(r, days) && matches(r, needle) &&
        (!by || replyStaff(r) === by));
      res.status(200).json(Object.assign(base, { rows: repliers(kept, sentAll) }));
      return;
    }
    if (view === "pipeline") {
      // 개인용 — 기본은 로그인한 본인, 담당자를 고르면 그 사람. 관리자 제외 필터는 적용하지 않는다
      // (본인이 관리자여도 자기 파이프라인은 봐야 한다). raw 배열에서 그 한 명만 추린다.
      const target = by || (me ? String(me.email).toLowerCase() : "");
      const win = r => withinDays(r, days) && matches(r, needle);
      const mineSent = sentAll.filter(r => win(r) && String(r.by || "").toLowerCase() === target);
      // 회신은 **그 회신이 도착한 메일함 주인** 기준으로만 고른다 — 같은 크리에이터를
      // 여러 담당자가 접촉했을 때 남의 메일함 회신이 섞이지 않게 (inbox 우선).
      const mineReplies = replyAll.filter(r => win(r) && replyStaff(r) === target);
      // 보낸 리마인드 로그 — 이 사람이 보낸 것만
      const remLog = await H.recentReminders(H.LOG_MAX);
      const mineRem = remLog.filter(r => win(r) && String(r.by || "").toLowerCase() === target);
      res.status(200).json(Object.assign(base, { rows: groupPipeline(mineSent, mineReplies, mineRem), pipelineOf: target }));
      return;
    }

    res.status(200).json(Object.assign(base, summarize(sent, blocked, replies), {
      recentSent: sent.slice(0, 20),
      recentBlocked: blocked.slice(0, 20)
    }));
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
