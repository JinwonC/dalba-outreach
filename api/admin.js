// Vercel Serverless Function — 배포 경로: /api/admin
//
// 관리자만 볼 수 있는 팀 전체 아웃리치 현황.
//
//   GET /api/admin                     → 요약 + 담당자별 집계
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
      res.status(200).json({
        historyEnabled: false,
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
    const sent = sentAll.filter(keep);
    const blocked = blockedAll.filter(keep);

    const base = {
      historyEnabled: true,
      windowDays: H.WINDOW_DAYS,
      me: A.publicUser(me),
      // 목록 상한에 걸렸으면 숨기지 않고 알린다 — 전부라고 오해하면 판단이 틀어진다
      truncated: sentAll.length >= limit
    };

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
