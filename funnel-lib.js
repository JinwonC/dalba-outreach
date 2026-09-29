// 📈 성과 — 발송 → 회신 → 협업 전환 (관리자 페이지). 저장된 발송·회신 기록과 협업 시트만으로 계산한다.
//
// 크리에이터 한 명 = 이메일 하나 (같은 사람에게 여러 번 보내도 1명). 기간·담당자 필터는 '발송'에 건다.
//   회신: 그 담당자의 **첫 발송 이후** 그 크리에이터(이메일 또는 연결된 핸들)에게서 온 회신이 있으면
//   협업: 지금 협업(인하우스) 시트에 있으면 — 시트는 현재 상태라, 예전부터 협업하던 사람이 섞일 수 있다
//
// 입력: sent(기간·담당자로 거른 발송), allSent(핸들 연결용 전체 발송), replies(전체 회신), match(협업 대조 함수|null)

const H = require("./history.js");

function prep(allSent, replies) {
  const e2h = new Map();
  (allSent || []).forEach(s => {
    const e = s && H.normEmail(s.to), h = s && H.normHandle(s.handle);
    if (e && h) { const a = e2h.get(e) || new Set(); a.add(h); e2h.set(e, a); }
  });
  const rE = new Map(), rH = new Map();
  const add = (m, k, at) => { if (!k) return; const a = m.get(k) || []; a.push(String(at || "")); m.set(k, a); };
  (replies || []).forEach(r => { if (!r) return; add(rE, H.normEmail(r.from), r.at); add(rH, H.normHandle(r.handle), r.at); });
  return { e2h, rE, rH };
}

// 크리에이터 모으기: key → { email, handle, firstAt, staff:Set, campaigns:Set }
function creatorsOf(sent, e2h) {
  const m = new Map();
  (sent || []).forEach(s => {
    const e = H.normEmail(s && s.to);
    if (!e) return;
    let c = m.get(e);
    if (!c) { c = { email: e, handle: H.normHandle(s.handle) || [...(e2h.get(e) || [])][0] || "", firstAt: "", byStaff: new Map(), campaigns: new Set() }; m.set(e, c); }
    const at = String(s.at || "");
    if (!c.firstAt || at < c.firstAt) c.firstAt = at;
    const by = H.normEmail(s.by);
    const prev = c.byStaff.get(by);
    if (!prev || at < prev) c.byStaff.set(by, at);
    c.campaigns.add(campaignOf(s));
  });
  return m;
}

function campaignOf(s) {
  if (s && s.source === "imap") return "(네이버웍스에서 직접 보낸 메일)";
  if (s && s.source === "mailbox") return "(네이버웍스에서 직접 보낸 메일)";
  return String((s && s.campaign) || "").trim() || "(캠페인 이름 없음)";
}

function repliedSince(c, since, ctx) {
  const hs = new Set([c.handle].concat([...(ctx.e2h.get(c.email) || [])]).filter(Boolean));
  const ok = arr => (arr || []).some(at => !since || at >= since);
  return ok(ctx.rE.get(c.email)) || [...hs].some(h => ok(ctx.rH.get(h)));
}

function funnel(o) {
  const ctx = prep(o.allSent || o.sent, o.replies);
  const creators = creatorsOf(o.sent, ctx.e2h);
  const names = o.names || new Map();
  const match = o.match || null;
  const collabOf = new Map();
  creators.forEach((c, e) => {
    let m = null;
    try { m = match ? match({ to: c.email, handle: c.handle }, [...(ctx.e2h.get(e) || [])]) : null; } catch (_) { m = null; }
    collabOf.set(e, Boolean(m));
  });
  const staff = new Map(), camps = new Map();
  const bump = (map, key, init) => { let x = map.get(key); if (!x) { x = Object.assign({ contacted: 0, replied: 0, collab: 0 }, init); map.set(key, x); } return x; };
  let tRep = 0, tCol = 0;
  creators.forEach((c, e) => {
    const collab = collabOf.get(e);
    if (repliedSince(c, c.firstAt, ctx)) tRep++;
    if (collab) tCol++;
    c.byStaff.forEach((firstAt, by) => {
      const x = bump(staff, by, { staff: by, name: names.get(by) || by });
      x.contacted++;
      if (repliedSince(c, firstAt, ctx)) x.replied++;
      if (collab) x.collab++;
    });
    c.campaigns.forEach(k => {
      const x = bump(camps, k, { campaign: k });
      x.contacted++;
      if (repliedSince(c, c.firstAt, ctx)) x.replied++;
      if (collab) x.collab++;
    });
  });
  const byContacted = (a, b) => b.contacted - a.contacted;
  return {
    totals: { contacted: creators.size, replied: tRep, collab: tCol },
    staff: [...staff.values()].sort(byContacted),
    campaigns: [...camps.values()].sort(byContacted),
    inhouseChecked: Boolean(match)
  };
}

// ─── 제목별 회신율 ─────────────────────────────────────────────────
// 같은 제목 틀로 보낸 크리에이터 중 몇 %가 회신했나. 제목 틀이 기록된 발송(툴)은 그 틀로,
// 아니면 실제 제목에서 크리에이터 이름·핸들을 {{name}} 으로 바꾸고 Re:/Fwd: 를 떼어 묶는다.
// 제목이 없는 예전 툴 발송(제목 저장 전)은 뺀다.
function escRe(x) { return String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function normSubject(subj, name, handle) {
  let s = String(subj || "").replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, "").trim();
  // 긴 것부터(@핸들 → 핸들 → 이름), 단어 단위로만 — 짧은 이름이 핸들 안에서 먼저 바뀌지 않게
  [handle && "@" + handle, handle, name].filter(x => x && String(x).length >= 2)
    .sort((a, b) => String(b).length - String(a).length)
    .forEach(v => { s = s.replace(new RegExp("(^|[^\\w@])" + escRe(v) + "(?![\\w])", "gi"), (m, pre) => pre + "{{name}}"); });
  return s.replace(/\s{2,}/g, " ").slice(0, 160);
}
function subjectOf(s) {
  if (s && s.subjectTpl) return String(s.subjectTpl);
  const raw = s && (s.subject || (s.source === "imap" ? s.campaign : ""));
  if (!raw) return "";
  return normSubject(raw, s.name, H.normHandle(s.handle));
}
function subjects(o) {
  const ctx = prep(o.allSent || o.sent, o.replies);
  const groups = new Map();      // 제목 → Map(이메일 → 첫 발송 시각)
  let skipped = 0;
  (o.sent || []).forEach(s => {
    const e = H.normEmail(s && s.to);
    if (!e) return;
    const k = subjectOf(s);
    if (!k) { skipped++; return; }
    const g = groups.get(k) || new Map();
    const at = String(s.at || "");
    if (!g.has(e) || at < g.get(e)) g.set(e, at);
    groups.set(k, g);
  });
  const rows = [];
  groups.forEach((g, k) => {
    let replied = 0;
    g.forEach((at, e) => { if (repliedSince({ email: e, handle: [...(ctx.e2h.get(e) || [])][0] || "" }, at, ctx)) replied++; });
    rows.push({ subject: k, contacted: g.size, replied });
  });
  rows.sort((a, b) => (b.replied / b.contacted) - (a.replied / a.contacted) || b.contacted - a.contacted);
  return { subjects: rows, subjectsSkipped: skipped };
}

module.exports = { funnel, subjects, normSubject, subjectOf, prep, campaignOf };
