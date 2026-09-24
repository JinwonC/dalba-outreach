// 달바 인하우스 협업 크리에이터 리스트 — 구글시트에서 읽는다.
//
// "유가 인원 정리" 시트의 여러 탭에서 **핸들 열**을 모아 "이미 협업 중인" 핸들 집합을 만든다.
// 용도: (1) 툴에서 모두가 볼 수 있는 리스트, (2) 이 핸들로는 발송 차단(관리자 제외).
//
// ─── 왜 헤더 이름으로 열을 찾나 ──────────────────────────────────
// 이 시트는 주차마다 열이 늘어나는 살아있는 작업 시트다. "O열" 처럼 문자로 고정하면
// 다음 주에 엉뚱한 열을 읽는다. 그래서 각 탭에서 **헤더 이름**(Handle/핸들/크리에이터명 …)
// 이 붙은 열을 찾아 그 열만 읽는다. 값이 이름·URL 이어도 핸들만 걸러낸다.
//
// ─── 설정 ────────────────────────────────────────────────────────
//   GOOGLE_SERVICE_ACCOUNT   서비스 계정 JSON (영상 기능과 공용). 시트를 이 계정에 뷰어로 공유.
//   INHOUSE_SHEET_ID         기본 1JFq6m2-rvSpiGKQsTpr91Hj-RckHpqFfEl_BLkQI_hs
//   INHOUSE_TABS             대상 탭 제목 키워드 (콤마), 기본 "GMV,담당자,캐스팅"
//   INHOUSE_HANDLE_HEADERS   핸들 열로 인정할 헤더 (콤마) — 기본값에 추가할 때만
//   INHOUSE_CACHE_MS         캐시 시간(ms), 기본 30분

const S = require("./sheets.js");
const H = require("./history.js");

const SHEET_ID = process.env.INHOUSE_SHEET_ID || "1JFq6m2-rvSpiGKQsTpr91Hj-RckHpqFfEl_BLkQI_hs";
const TAB_KEYWORDS = String(process.env.INHOUSE_TABS || "GMV,담당자,캐스팅")
  .split(/[,;]/).map(s => s.trim().toLowerCase()).filter(Boolean);
const HANDLE_HEADERS = new Set(
  ["handle", "핸들", "크리에이터명", "크리에이터 핸들", "크리에이터핸들", "크리에이터 이름",
   "creator username", "creator handle", "username", "tiktok handle", "틱톡 핸들", "틱톡핸들", "tiktok"]
    .concat(String(process.env.INHOUSE_HANDLE_HEADERS || "").split(/[,;]/).map(s => s.trim().toLowerCase()))
    .filter(Boolean)
);
const CACHE_MS = Number(process.env.INHOUSE_CACHE_MS || 30 * 60e3);

let cache = { at: 0, handles: null, emails: new Map(), tabs: [], error: "" };

function configured() { return Boolean(S.serviceAccount()); }

// 0→A, 25→Z, 26→AA …
function colLetter(i) {
  let s = "";
  for (i = i + 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

// 한 칸에서 핸들만 뽑는다. TikTok URL 이면 핸들 추출, @ 제거. 이름(공백·한글)·빈칸은 버린다.
function extractHandle(v) {
  let s = String(v == null ? "" : v).trim();
  if (!s) return "";
  const m = s.match(/tiktok\.com\/@([A-Za-z0-9._]+)/i);
  if (m) s = m[1];
  s = s.replace(/^@+/, "").trim();
  if (!/^[A-Za-z0-9._]{2,30}$/.test(s)) return "";   // 핸들 형식만 인정 (이름 칸 제외)
  return s.toLowerCase();
}

async function sheetTitles(token) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties(title,index)`;
  const r = await fetch(url, { headers: { authorization: "Bearer " + token } });
  const d = await r.json();
  if (d.error) {
    if (r.status === 403) throw new Error("시트가 서비스 계정에 공유되지 않았습니다 — " + (S.serviceAccount() || {}).client_email + " 을 뷰어로 추가하세요");
    throw new Error("시트 탭 목록 실패: " + (d.error.message || ""));
  }
  return (d.sheets || []).map(s => (s.properties || {}).title).filter(Boolean);
}

// 헤더(앞 6행)에서 핸들 열과 이메일 열을 찾는다.
const EMAIL_HEADERS = new Set(
  ["email", "e-mail", "email address", "e-mail address", "contact email", "이메일", "이메일 주소", "메일", "메일 주소", "gmail"]
    .concat(String(process.env.INHOUSE_EMAIL_HEADERS || "").split(/[,;]/).map(s => s.trim().toLowerCase()))
    .filter(Boolean)
);
function findHeaders(rows) {
  let hcol = -1, ecol = -1, headerRow = -1;
  for (let r = 0; r < Math.min(6, rows.length) && hcol < 0; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      const v = String(row[c] == null ? "" : row[c]).trim().toLowerCase();
      if (hcol < 0 && HANDLE_HEADERS.has(v)) { hcol = c; headerRow = r; }
    }
    if (hcol >= 0) {
      for (let c = 0; c < row.length; c++) {
        if (EMAIL_HEADERS.has(String(row[c] == null ? "" : row[c]).trim().toLowerCase())) { ecol = c; break; }
      }
    }
  }
  return { hcol, ecol, headerRow };
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const COMPANY_DOMAINS = (process.env.NW_DOMAIN || "dalbausa.com,dalba.com")
  .split(",").map(s => s.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);
function isCompanyEmail(e) { return COMPANY_DOMAINS.includes(String(e || "").toLowerCase().split("@")[1] || ""); }
function emailsIn(v) { return (String(v == null ? "" : v).match(EMAIL_RE) || []).map(x => H.normEmail(x)).filter(x => x && !isCompanyEmail(x)); }

// 모든 탭을 한 번의 요청(batchGet)으로 읽는다.
async function readAllTabs(token, titles) {
  if (!titles.length) return [];
  const q = titles.map(t => "ranges=" + encodeURIComponent("'" + String(t).replace(/'/g, "''") + "'")).join("&");
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchGet?majorDimension=ROWS&${q}`,
    { headers: { authorization: "Bearer " + token } });
  const d = await r.json();
  if (d.error) throw new Error("시트 읽기 실패: " + (d.error.message || ""));
  return (d.valueRanges || []).map((vr, i) => ({ title: titles[i], rows: vr.values || [] }));
}

// 협업 핸들 집합(+ 그 크리에이터의 이메일)을 불러온다(캐시).
//   · 핸들: 대상 탭(GMV·담당자·캐스팅)의 핸들 열
//   · 이메일: 같은 행에 적힌 이메일 — 대상 탭은 이메일 열(없으면 그 행의 이메일 칸),
//     다른 탭(예: 배송·신청 폼)은 핸들 열과 이메일 열이 **둘 다** 헤더로 있을 때만.
//     다른 크리에이터 이메일이 잘못 붙지 않도록, 행의 핸들은 반드시 핸들 열에서만 읽는다.
// 실패해도 마지막 성공 캐시를 유지한다 — 발송이 통째로 막히면 안 된다.
async function loadHandles() {
  if (cache.handles && Date.now() - cache.at < CACHE_MS) return cache;
  if (!configured()) { cache = Object.assign({}, cache, { at: Date.now(), handles: cache.handles || new Set(), tabs: [], error: "GOOGLE_SERVICE_ACCOUNT 가 설정되지 않았습니다" }); return finish(cache); }
  try {
    const token = await S.accessToken();
    const titles = await sheetTitles(token);
    const tabsData = await readAllTabs(token, titles);
    const set = new Set();
    const tabs = [];
    const rowLinks = [];   // [handle, [emails]]
    let targets = 0;
    for (const { title, rows } of tabsData) {
      const target = TAB_KEYWORDS.some(k => title.toLowerCase().includes(k));
      const { hcol, ecol, headerRow } = findHeaders(rows);
      if (target) targets++;
      if (hcol < 0) { if (target) tabs.push({ tab: title, count: 0, error: "핸들 열(헤더)을 찾지 못했습니다" }); continue; }
      if (!target && ecol < 0) continue;
      let n = 0;
      for (let r = headerRow + 1; r < rows.length; r++) {
        const row = rows[r] || [];
        const h = extractHandle(row[hcol]);
        if (!h) continue;
        if (target) { set.add(h); n++; }
        const em = ecol >= 0 ? emailsIn(row[ecol]) : (target ? [].concat(...row.map(emailsIn)) : []);
        if (em.length) rowLinks.push([h, em]);
      }
      if (target) tabs.push({ tab: title, count: n });
    }
    const emails = new Map();
    rowLinks.forEach(([h, em]) => { if (set.has(h)) em.forEach(e => { if (!emails.has(e)) emails.set(e, h); }); });
    cache = { at: Date.now(), handles: set, emails, tabs, error: targets ? "" : "대상 탭을 찾지 못했습니다 (INHOUSE_TABS 확인)" };
  } catch (e) {
    cache = Object.assign({}, cache, { at: Date.now(), handles: cache.handles || new Set(), tabs: cache.tabs || [], error: String((e && e.message) || e) });
  }
  return finish(cache);
}

// ─── 매칭 ────────────────────────────────────────────────────────
// 수신자 한 명이 협업 리스트의 누구인지. 순서대로 확실한 것부터:
//   handle        입력한 핸들이 리스트에 있음
//   linked        이메일이 발송 기록에서 리스트 핸들과 연결돼 있음 (브리지)
//   sheet-email   시트에 그 크리에이터 이메일로 적혀 있음
//   email-prefix  이메일 앞부분이 리스트 핸들로 시작함 (추정, 예: yaniratipsparati@ ↔ yaniratips)
//                 짧은 핸들은 오탐이 나므로 INHOUSE_EMAIL_PREFIX_MIN(기본 7)글자 이상만, 0 이면 끔.
const PREFIX_MIN = (process.env.INHOUSE_EMAIL_PREFIX_MIN != null && process.env.INHOUSE_EMAIL_PREFIX_MIN !== "")
  ? Number(process.env.INHOUSE_EMAIL_PREFIX_MIN) : 7;
function squash(s) { return String(s || "").toLowerCase().replace(/[._\-]/g, ""); }
function finish(c) {
  if (!c.emails) c.emails = new Map();
  const sq = new Map();
  (c.handles || new Set()).forEach(h => { const k = squash(h); if (PREFIX_MIN > 0 && k.length >= PREFIX_MIN && !sq.has(k)) sq.set(k, h); });
  c.squashed = sq;
  return c;
}
function matchOne(c, r, linkedHandles) {
  const set = (c && c.handles) || new Set();
  if (!set.size) return null;
  const h = H.normHandle(r && (r.handle || r.creatorHandle));
  if (h && set.has(h)) return { handle: h, via: "handle" };
  for (const lh of (linkedHandles || [])) {
    const x = H.normHandle(lh);
    if (x && set.has(x)) return { handle: x, via: "linked" };
  }
  const e = H.normEmail(r && (r.to || r.email));
  if (!e || e.indexOf("@") < 1 || isCompanyEmail(e)) return null;
  if (c.emails && c.emails.has(e)) return { handle: c.emails.get(e), via: "sheet-email" };
  if (PREFIX_MIN > 0 && c.squashed && c.squashed.size) {
    const local = squash(e.split("@")[0]);
    for (let L = local.length; L >= PREFIX_MIN; L--) {
      const hit = c.squashed.get(local.slice(0, L));
      if (hit) return { handle: hit, via: "email-prefix" };
    }
  }
  return null;
}
// 한 번 불러 두고 여러 명을 대조할 때 쓴다 (실패하면 아무도 매칭 안 됨 — fail-open)
async function matcher() {
  let c = null;
  try { c = await module.exports.loadHandles(); } catch (_) { c = null; }
  return (r, linked) => (c ? matchOne(c, r, linked) : null);
}

async function handleSet() { return (await loadHandles()).handles || new Set(); }

async function summary() {
  const c = await loadHandles();
  const handles = [...(c.handles || new Set())].sort();
  return {
    configured: configured(), count: handles.length, handles,
    emailCount: (c.emails && c.emails.size) || 0,
    tabs: c.tabs, updatedAt: c.at ? new Date(c.at).toISOString() : "", error: c.error || undefined
  };
}

module.exports = { configured, loadHandles, handleSet, summary, extractHandle, colLetter, matchOne, matcher, SHEET_ID };
