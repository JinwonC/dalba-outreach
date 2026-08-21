// Vercel Serverless Function — 배포 경로: /api/lookup
//
// 중복 검사기. 크리에이터 **핸들 또는 이메일**을 넣으면, 전체 담당자(관리자 포함)의 발송
// 이력에서 그 사람에게 보낸 적이 있는지 · 누가 · 언제 보냈는지를 찾아 준다.
//
//   GET  /api/lookup?q=creator@x.com      → 한 명 조회
//   POST /api/lookup  { queries:[...] }    → 여러 명 한 번에 (붙여넣기용)
//
// ─── 관리자도 포함한다 ───────────────────────────────────────────
// 관리자 페이지의 집계는 관리자 본인 발송을 빼지만, 이 검사기는 **누가 보냈든** 다 보여준다
// (진짜로 이미 접촉했는지 알아야 하므로). 로그인한 담당자면 누구나 쓸 수 있다.
//
// ─── 여러 개를 한 번에 ───────────────────────────────────────────
// 수백~수천 개를 붙여넣어도 로그(발송·회신)를 **딱 한 번**만 읽고, 이메일/핸들 기준으로
// 색인을 만들어 각 입력을 대조한다. 입력마다 따로 읽으면 저장소가 못 버틴다.

const A = require("../auth.js");
const H = require("../history.js");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_QUERIES = 5000;   // 한 번에 검사할 수 있는 최대 개수

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch (_) { return {}; } }
  return b;
}

// 발송/회신 로그를 한 번 읽어 이메일·핸들 색인을 만든다. 각 키에 대해 집계만 남긴다
// (건수·담당자·마지막 발송·회신수) — 원본 배열을 다 들고 있지 않아 큰 입력에도 가볍다.
async function buildIndex() {
  const [sentAll, replyAll] = await Promise.all([
    H.recent(H.LOG_MAX),
    H.recentReplies(H.REPLY_MAX)
  ]);

  const sEmail = new Map(), sHandle = new Map();
  const rEmail = new Map(), rHandle = new Map();

  const agg = (map, key) => {
    let a = map.get(key);
    if (!a) { a = { count: 0, senders: new Set(), lastAt: "", lastBy: "", lastCampaign: "", forced: false, name: "", handle: "" }; map.set(key, a); }
    return a;
  };

  (sentAll || []).forEach(r => {
    const rec = { by: r.by || "", byName: r.byName || r.by || "", at: r.at || "", campaign: r.campaign || "", forced: Boolean(r.forced), name: r.name || "", handle: r.handle || "" };
    const put = (map, key) => {
      if (!key) return;
      const a = agg(map, key);
      a.count++;
      if (rec.byName) a.senders.add(rec.byName);
      if (String(rec.at) > String(a.lastAt)) { a.lastAt = rec.at; a.lastBy = rec.byName; a.lastCampaign = rec.campaign; a.forced = rec.forced; }
      if (!a.name && rec.name) a.name = rec.name;
      if (!a.handle && rec.handle) a.handle = rec.handle;
    };
    put(sEmail, H.normEmail(r.to));
    put(sHandle, H.normHandle(r.handle));
  });

  const bumpReply = (map, key) => { if (!key) return; map.set(key, (map.get(key) || 0) + 1); };
  (replyAll || []).forEach(r => {
    bumpReply(rEmail, H.normEmail(r.from));
    bumpReply(rHandle, H.normHandle(r.handle));
  });

  return { sEmail, sHandle, rEmail, rHandle };
}

// 한 입력(핸들 또는 이메일)에 대한 조회 결과
function summarizeOne(q, idx) {
  const isEmail = EMAIL_RE.test(q);
  const key = isEmail ? H.normEmail(q) : H.normHandle(q);
  const a = (isEmail ? idx.sEmail : idx.sHandle).get(key);
  const replyCount = (isEmail ? idx.rEmail : idx.rHandle).get(key) || 0;
  if (!a) {
    return { query: q, kind: isEmail ? "email" : "handle", found: false, sentCount: 0, senders: [], lastAt: "", lastBy: "", lastCampaign: "", forced: false, replyCount, name: "", handle: "" };
  }
  return {
    query: q, kind: isEmail ? "email" : "handle", found: true,
    sentCount: a.count, senders: [...a.senders],
    lastAt: a.lastAt, lastBy: a.lastBy, lastCampaign: a.lastCampaign, forced: a.forced,
    replyCount, name: a.name, handle: a.handle
  };
}

module.exports = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    if (A.enabled()) {
      const me = A.currentUser(req);
      if (!me) { res.status(401).json({ error: "로그인이 필요합니다" }); return; }
    } else {
      const PW = process.env.DASHBOARD_PASSWORD;
      if (PW) {
        const given = req.headers["x-dashboard-password"] || (req.query && req.query.pw) || "";
        if (given !== PW) { res.status(401).json({ error: "unauthorized" }); return; }
      }
    }

    if (!H.enabled()) {
      res.status(200).json({ historyEnabled: false, results: [], found: false });
      return;
    }

    // ─── POST: 여러 개 한 번에 ───────────────────────────────────
    if (req.method === "POST") {
      const body = readBody(req);
      const raw = Array.isArray(body.queries) ? body.queries : [];
      // 입력 순서 유지하며 정규화 기준으로 중복 제거
      const seen = new Set();
      const queries = [];
      for (const s of raw) {
        const q = String(s == null ? "" : s).trim();
        if (!q) continue;
        const norm = EMAIL_RE.test(q) ? H.normEmail(q) : H.normHandle(q);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        queries.push(q);
        if (queries.length >= MAX_QUERIES) break;
      }
      if (!queries.length) { res.status(400).json({ error: "검사할 핸들 또는 이메일을 입력하세요" }); return; }

      const idx = await buildIndex();
      const results = queries.map(q => summarizeOne(q, idx));
      const foundCount = results.filter(r => r.found).length;
      res.status(200).json({
        historyEnabled: true,
        count: results.length,
        foundCount,
        cleanCount: results.length - foundCount,
        truncated: raw.length > queries.length && queries.length >= MAX_QUERIES,
        results
      });
      return;
    }

    // ─── GET: 한 명 ──────────────────────────────────────────────
    if (req.method !== "GET") { res.status(405).json({ error: "method not allowed" }); return; }
    const q = String((req.query && req.query.q) || "").trim();
    if (!q) { res.status(400).json({ error: "핸들 또는 이메일을 입력하세요" }); return; }

    const idx = await buildIndex();
    const one = summarizeOne(q, idx);
    // 단건은 기존 화면과 호환되게 sent/replies 상세도 흉내 내지 않고 요약 형태로 준다
    res.status(200).json(Object.assign({ historyEnabled: true, found: one.found, sentCount: one.sentCount, replyCount: one.replyCount, senders: one.senders }, { results: [one] }));
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
