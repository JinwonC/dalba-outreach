// Vercel Serverless Function — 배포 경로: /api/admin
//
// 관리자만 볼 수 있는 팀 전체 아웃리치 현황.
//
//   GET /api/admin                     → 요약 + 담당자별 집계
//   GET /api/admin?view=daily&tz=-540  → 일별 발송 건수 (tz 는 브라우저 시차, 분)
//   GET /api/admin?view=sent&by=…      → 발송 이력 (담당자로 거르기)
//   GET /api/admin?view=blocked        → 중복이라 보류된 시도
//   GET /api/admin?view=people         → 접촉한 크리에이터 단위로 묶어서
//   공통 파라미터: limit(기본 500), q(주소·이름·핸들·캠페인 검색), days(최근 N일)
//
// ─── 누가 관리자인가 ─────────────────────────────────────────────
// 환경변수 ADMIN_EMAILS 에 적힌 주소만. 예) jinwon.choi@dalba.com,hannie@dalbausa.com
// 비워 두면 **아무도 관리자가 아니다** — 관리자 판정을 코드에 숨겨 두면
// 나중에 이 배포를 보는 사람이 권한 범위를 알 수 없기 때문에, 반드시 명시하게 했다.

const A = require("../auth.js");
const H = require("../history.js");

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

function isAdmin(user) {
  return Boolean(user && ADMIN_EMAILS.includes(String(user.email).toLowerCase()));
}

// 검색어는 주소·이름·핸들·캠페인·담당자 어디에 걸려도 잡히게 한다
function matches(r, q) {
  if (!q) return true;
  const hay = [r.to, r.name, r.handle, r.campaign, r.by, r.byName]
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
    out.push(map.get(k) || { date: k, sent: 0, blocked: 0, by: {} });
  }
  return out;
}

function daily(sent, blocked, tzMin, days) {
  const m = new Map();
  const touch = k => {
    let cur = m.get(k);
    if (!cur) { cur = { date: k, sent: 0, blocked: 0, by: {} }; m.set(k, cur); }
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

  return fillDays(m, days, tzMin, 180);
}

function summarize(sent, blocked) {
  const byPerson = new Map();
  sent.forEach(r => {
    const k = r.by || "(알 수 없음)";
    const cur = byPerson.get(k) || { email: k, name: r.byName || "", sent: 0, blocked: 0, lastAt: "" };
    cur.sent++;
    if (!cur.name && r.byName) cur.name = r.byName;
    if (String(r.at || "") > cur.lastAt) cur.lastAt = r.at || "";
    byPerson.set(k, cur);
  });
  blocked.forEach(r => {
    const k = r.by || "(알 수 없음)";
    const cur = byPerson.get(k) || { email: k, name: r.byName || "", sent: 0, blocked: 0, lastAt: "" };
    cur.blocked++;
    byPerson.set(k, cur);
  });

  const uniq = new Set(sent.map(r => H.normEmail(r.to)).filter(Boolean));
  return {
    totals: { sent: sent.length, people: uniq.size, blocked: blocked.length },
    staff: [...byPerson.values()].sort((a, b) => b.sent - a.sent)
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
    if (!ADMIN_EMAILS.length) {
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
    const limit = Math.max(1, Math.min(Number(q.limit) || 500, H.LOG_MAX));
    const days = Number(q.days) || 0;
    const needle = String(q.q || "").trim().toLowerCase();
    const by = String(q.by || "").trim().toLowerCase();

    const [sentAll, blockedAll] = await Promise.all([
      H.recent(limit),
      H.recentBlocked(Math.min(limit, H.BLOCK_MAX))
    ]);

    const keep = r => withinDays(r, days) && matches(r, needle) &&
      (!by || String(r.by || "").toLowerCase() === by);

    // 저장된 순서에 기대지 않고 항상 시각순으로 정렬한다.
    // 보낸편지함에서 가져온 기록은 실제 발송 시각이 제각각이라 삽입 순서와 어긋난다.
    const byTime = (a, b) => String(b.at || "").localeCompare(String(a.at || ""));
    const sent = sentAll.filter(keep).sort(byTime);
    const blocked = blockedAll.filter(keep).sort(byTime);

    const base = {
      historyEnabled: true,
      windowDays: H.WINDOW_DAYS,
      me: A.publicUser(me),
      // 목록 상한에 걸렸으면 숨기지 않고 알린다 — 전부라고 오해하면 판단이 틀어진다
      truncated: sentAll.length >= limit
    };

    if (view === "daily") {
      // tz 는 브라우저의 getTimezoneOffset() (KST 는 -540). 없으면 UTC 기준이 된다.
      const tzMin = Number.isFinite(Number(q.tz)) ? Number(q.tz) : 0;
      res.status(200).json(Object.assign(base, {
        rows: daily(sent, blocked, tzMin, days),
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

    res.status(200).json(Object.assign(base, summarize(sent, blocked), {
      recentSent: sent.slice(0, 20),
      recentBlocked: blocked.slice(0, 20)
    }));
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
