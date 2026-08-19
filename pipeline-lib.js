// 개인 파이프라인 집계 — 관리자 페이지(api/admin.js)와 발송 화면(api/pipeline.js)이
// 같은 로직을 쓰도록 한 곳에 둔다. 두 곳에 따로 두면 단계 기준이 조용히 갈린다.
//
// 한 담당자가 접촉한 크리에이터를 단계별로 나눈다:
//   첫 발송(회신 대기) · 1차 리마인드 보냄 · 2차+ 리마인드 보냄 · 1차 회신 · 2차+ 회신(협상)
// 회신이 있으면 회신 단계로, 없으면 보낸 리마인드 횟수로 매긴다. 회신이 리마인드보다 우선.

const H = require("./history.js");

function groupPipeline(sent, replies, reminders) {
  const c = new Map();
  const get = (email, name, handle) => {
    const k = H.normEmail(email);
    if (!c.has(k)) c.set(k, { email: email, name: name || "", handle: handle || "", sends: 0, replies: 0, reminds: 0, lastAt: "", lastSubject: "", campaign: "" });
    const x = c.get(k);
    if (name && !x.name) x.name = name;
    if (handle && !x.handle) x.handle = handle;
    return x;
  };
  (sent || []).forEach(r => {
    const x = get(r.to, r.name, r.handle);
    x.sends++;
    if (String(r.at || "") > String(x.lastAt || "")) { x.lastAt = r.at || ""; x.campaign = r.campaign || x.campaign; }
  });
  (replies || []).forEach(r => {
    const x = get(r.from, r.fromName, "");
    x.replies++;
    if (String(r.at || "") > String(x.lastAt || "")) { x.lastAt = r.at || ""; x.lastSubject = r.subject || x.lastSubject; }
  });
  (reminders || []).forEach(r => {
    const x = get(r.to, r.name, r.handle);
    x.reminds = Math.max(x.reminds || 0, Number(r.n) || 0);
    if (String(r.at || "") > String(x.lastAt || "")) x.lastAt = r.at || "";
  });
  const stageOf = x =>
    x.replies >= 2 ? "reply2" :
    x.replies === 1 ? "reply1" :
    x.reminds >= 2 ? "remind2" :
    x.reminds === 1 ? "remind1" : "outreach";
  return [...c.values()]
    .map(x => Object.assign(x, { stage: stageOf(x) }))
    .sort((a, b) => String(b.lastAt || "").localeCompare(String(a.lastAt || "")));
}

module.exports = { groupPipeline };
