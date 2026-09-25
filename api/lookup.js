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
const IH = require("../inhouse.js");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_QUERIES = 5000;   // 한 번에 검사할 수 있는 최대 개수

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch (_) { return {}; } }
  return b;
}

// 발송/회신 로그를 한 번 읽어 이메일·핸들 색인을 만든다. 각 키에는 발송 기록 번호만 담는다
// (이메일·핸들 양쪽으로 잡힌 같은 발송을 두 번 세지 않도록 번호로 합친다).
// 함께 이메일↔핸들 연결도 만든다 — 한 번이라도 이메일+핸들이 같이 기록된 크리에이터는,
// 이후 이메일로만(또는 핸들로만) 기록된 발송까지 한 사람으로 묶어 찾는다.
async function buildIndex() {
  const [sentAll, replyAll] = await Promise.all([
    H.recent(H.LOG_MAX),
    H.recentReplies(H.REPLY_MAX)
  ]);
  // 제외 발신자의 발송은 중복 계산에 넣지 않는다 (DEDUP_IGNORE_SENDERS)
  const sent = (sentAll || []).filter(r => r && !H.isIgnoredSender(r.by));
  // 담당자 보낸편지함(주소록) — 네이버웍스에서 단체·참조·숨은참조로 보낸 상대도 '보낸 적 있음'.
  // 발송 기록에 이미 그 담당자→그 주소가 있으면 같은 발송이므로 더하지 않는다.
  try {
    const have = new Set(sent.map(r => H.normEmail(r.by) + "|" + H.normEmail(r.to)));
    const names = new Map(A.parseAccounts().map(a => [H.normEmail(a.email), a.name || ""]));
    for (const owner of await H.bookOwners()) {
      if (H.isIgnoredSender(owner)) continue;
      for (const b of await H.bookAll("sent", owner)) {
        const e = H.normEmail(b.email);
        if (!e || have.has(H.normEmail(owner) + "|" + e)) continue;
        sent.push({ to: e, by: owner, byName: names.get(H.normEmail(owner)) || owner, at: b.last || b.first || "",
          campaign: "", count: Number(b.n) || 1, source: "mailbox" });
      }
    }
  } catch (_) { /* 주소록을 못 읽어도 발송 기록만으로 검사는 계속 */ }
  const sEmail = new Map(), sHandle = new Map(), e2h = new Map(), h2e = new Map();
  const push = (map, k, v) => { if (!k) return; let a = map.get(k); if (!a) { a = []; map.set(k, a); } a.push(v); };
  const link = (map, k, v) => { let a = map.get(k); if (!a) { a = new Set(); map.set(k, a); } a.add(v); };
  sent.forEach((r, i) => {
    const e = H.normEmail(r.to), h = H.normHandle(r.handle);
    push(sEmail, e, i); push(sHandle, h, i);
    if (e && h) { link(e2h, e, h); link(h2e, h, e); }
  });
  const rEmail = new Map(), rHandle = new Map();
  const bump = (map, key) => { if (!key) return; map.set(key, (map.get(key) || 0) + 1); };
  (replyAll || []).forEach(r => { bump(rEmail, H.normEmail(r.from)); bump(rHandle, H.normHandle(r.handle)); });
  return { sent, sEmail, sHandle, e2h, h2e, rEmail, rHandle };
}

// 한 입력(핸들 또는 이메일)에 대한 조회 결과. match 가 있으면 협업 리스트도 함께 대조한다
// (핸들 · 연결된 핸들 · 시트 이메일 · 이메일 주소 추정).
function summarizeOne(q, idx, match) {
  const isEmail = EMAIL_RE.test(q);
  const emails = new Set(), handles = new Set();
  if (isEmail) { const e = H.normEmail(q); emails.add(e); (idx.e2h.get(e) || []).forEach(h => handles.add(h)); }
  else { const h = H.normHandle(q); if (h) handles.add(h); (idx.h2e.get(h) || []).forEach(e => emails.add(e)); }

  const ids = new Set();
  emails.forEach(e => (idx.sEmail.get(e) || []).forEach(i => ids.add(i)));
  handles.forEach(h => (idx.sHandle.get(h) || []).forEach(i => ids.add(i)));

  let replyCount = 0;
  emails.forEach(e => { replyCount += idx.rEmail.get(e) || 0; });
  handles.forEach(h => { replyCount += idx.rHandle.get(h) || 0; });

  const a = { count: 0, senders: new Set(), lastAt: "", lastBy: "", lastCampaign: "", forced: false, name: "", handle: "" };
  ids.forEach(i => {
    const r = idx.sent[i];
    a.count += Number(r.count) || 1;
    const who = r.byName || r.by || "";
    if (who) a.senders.add(who);
    if (String(r.at || "") > String(a.lastAt)) { a.lastAt = r.at || ""; a.lastBy = who; a.lastCampaign = r.campaign || ""; a.forced = Boolean(r.forced); }
    if (!a.name && r.name) a.name = r.name;
    if (!a.handle && r.handle) a.handle = H.normHandle(r.handle);
  });

  const m = match ? match(isEmail ? { to: q, handle: a.handle } : { handle: q }, [...handles]) : null;
  const inhouse = Boolean(m);
  // 연결로 찾은 쪽 (예: 이메일로 검사했는데 그 이메일과 연결된 핸들)
  const linked = isEmail ? [...handles] : [...emails];
  const base = {
    query: q, kind: isEmail ? "email" : "handle", inhouse,
    inhouseHandle: m ? m.handle : "", inhouseVia: m ? m.via : "",
    linked, replyCount
  };
  if (!a.count) {
    return Object.assign(base, { found: inhouse, sentCount: 0, senders: [], lastAt: "", lastBy: "", lastCampaign: "", forced: false, name: "", handle: "" });
  }
  return Object.assign(base, {
    found: true, sentCount: a.count, senders: [...a.senders],
    lastAt: a.lastAt, lastBy: a.lastBy, lastCampaign: a.lastCampaign, forced: a.forced,
    name: a.name, handle: a.handle
  });
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

    // 인하우스 협업 리스트도 함께 대조한다 (핸들·이메일). 못 읽어도 검사는 계속(아무도 매칭 안 됨).
    const match = await IH.matcher();

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
      const results = queries.map(q => summarizeOne(q, idx, match));
      const foundCount = results.filter(r => r.found).length;
      res.status(200).json({
        historyEnabled: true,
        count: results.length,
        foundCount,
        cleanCount: results.length - foundCount,
        inhouseCount: results.filter(r => r.inhouse).length,
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
    const one = summarizeOne(q, idx, match);
    // 단건은 기존 화면과 호환되게 sent/replies 상세도 흉내 내지 않고 요약 형태로 준다
    res.status(200).json(Object.assign({ historyEnabled: true, found: one.found, sentCount: one.sentCount, replyCount: one.replyCount, senders: one.senders }, { results: [one] }));
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
};
