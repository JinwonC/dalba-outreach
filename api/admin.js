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
  const staff = new Map();
  const ensure = (byKey, byName) => {
    if (!staff.has(byKey)) staff.set(byKey, { by: byKey, byName: byName || byKey, creators: new Map() });
    return staff.get(byKey);
  };
  replies.forEach(r => {
    const byKey = String(r.by || r.inbox || "").toLowerCase();
    const ck = H.normEmail(r.from);
    if (!byKey || !ck) return;
    const s = ensure(byKey, r.byName);
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

// 담당자 목록은 **등록된 직원 명단(NW_ACCOUNTS)** 에서 시작한다.
// 발송 기록에서만 뽑으면 아직 이 도구로 안 보낸 사람이 목록에 없고, 그러면
// 그 사람의 지난 발송을 가져오려 해도 고를 수가 없다 — 순환에 걸린다.
// 관리자는 감시하는 쪽이지 실적 집계 대상이 아니다. ADMIN_EMAILS 에 있는 사람은
// 담당자 명단(0건 행·담당자 선택칸)에서 뺀다. 관리자이자 담당자인 사람도 여기서는 제외된다.
function roster() {
  const admins = A.adminEmails();
  return A.parseAccounts()
    .filter(a => !admins.includes(String(a.email || "").toLowerCase()))
    .map(a => ({
      email: a.email,
      name: a.name || a.email.split("@")[0],
      title: a.title || ""
    }));
}

// 기록의 담당자(발송자/받은편지함 주인)가 관리자면 모든 뷰에서 뺀다.
function ownerIsAdmin(r, admins) {
  return admins.includes(String(r.by || "").toLowerCase()) ||
         admins.includes(String(r.inbox || "").toLowerCase());
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
    const k = r.by || "(알 수 없음)";
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

    const q = req.query || {};
    const view = String(q.view || "summary");
    const displayLimit = Math.max(1, Math.min(Number(q.limit) || 1000, H.LOG_MAX));
    const days = Number(q.days) || 0;
    const needle = String(q.q || "").trim().toLowerCase();
    const by = String(q.by || "").trim().toLowerCase();

    // 집계(요약·담당자별·일별)는 전부 읽어야 정확하다 — 일부만 읽으면 건수가 실제보다 적게 잡힌다.
    // 목록 뷰(발송 이력·중복·회신)만 표시 개수로 제한한다. 읽기는 청크라 실제 데이터만큼만 받는다.
    const countView = view === "summary" || view === "daily" || view === "people" || view === "conversations" || view === "pipeline";
    const readN = countView ? H.LOG_MAX : displayLimit;

    let cronStatus = null;
    try { cronStatus = JSON.parse(await H.readRaw("outreach:cron:status")); } catch (_) {}

    const [sentAll, blockedAll, replyAll, totalSent, totalBlocked, totalReplies] = await Promise.all([
      H.recent(readN),
      H.recentBlocked(Math.min(readN, H.BLOCK_MAX)),
      H.recentReplies(Math.min(readN, H.REPLY_MAX)),
      H.count(H.LOG_KEY),
      H.count(H.BLOCK_KEY),
      H.count(H.REPLY_KEY)
    ]);

    // 관리자 본인의 발송·회신·시도는 집계에서 뺀다 (감시하는 쪽이라 대상이 아니다)
    const admins = A.adminEmails();
    const keep = r => withinDays(r, days) && matches(r, needle) &&
      !ownerIsAdmin(r, admins) &&
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
    if (view === "sent") { res.status(200).json(Object.assign(base, { rows: sent })); return; }
    if (view === "blocked") { res.status(200).json(Object.assign(base, { rows: blocked })); return; }
    if (view === "people") {
      res.status(200).json(Object.assign(base, { rows: groupByPerson(sent, blocked) }));
      return;
    }

    if (view === "replies") { res.status(200).json(Object.assign(base, { rows: replies })); return; }
    if (view === "conversations") { res.status(200).json(Object.assign(base, { rows: conversations(sent, replies) })); return; }
    if (view === "pipeline") {
      // 개인용 — 기본은 로그인한 본인, 담당자를 고르면 그 사람. 관리자 제외 필터는 적용하지 않는다
      // (본인이 관리자여도 자기 파이프라인은 봐야 한다). raw 배열에서 그 한 명만 추린다.
      const target = by || (me ? String(me.email).toLowerCase() : "");
      const win = r => withinDays(r, days) && matches(r, needle);
      const mineSent = sentAll.filter(r => win(r) && String(r.by || "").toLowerCase() === target);
      const mineReplies = replyAll.filter(r => win(r) && (String(r.by || "").toLowerCase() === target || String(r.inbox || "").toLowerCase() === target));
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
