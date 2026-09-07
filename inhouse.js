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

let cache = { at: 0, handles: null, tabs: [], error: "" };

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

// 한 탭에서 핸들 열을 찾아 값을 읽는다. 헤더가 1행이 아닐 수 있어 앞 6행을 훑는다.
async function readTabHandles(token, title) {
  const get = async range => {
    const r = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?majorDimension=ROWS`,
      { headers: { authorization: "Bearer " + token } });
    return r.json();
  };
  const hd = await get(`'${title}'!1:6`);
  if (hd.error) return { handles: [], error: hd.error.message };
  const rows = hd.values || [];
  let col = -1, headerRow = -1;
  for (let r = 0; r < rows.length && col < 0; r++) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (HANDLE_HEADERS.has(String(row[c] == null ? "" : row[c]).trim().toLowerCase())) { col = c; headerRow = r; break; }
    }
  }
  if (col < 0) return { handles: [], error: "핸들 열(헤더)을 찾지 못했습니다" };

  const cd = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`'${title}'!${colLetter(col)}:${colLetter(col)}`)}?majorDimension=COLUMNS`,
    { headers: { authorization: "Bearer " + token } }).then(r => r.json());
  if (cd.error) return { handles: [], error: cd.error.message };
  const colVals = (cd.values && cd.values[0]) || [];
  const out = [];
  for (let r = headerRow + 1; r < colVals.length; r++) {
    const h = extractHandle(colVals[r]);
    if (h) out.push(h);
  }
  return { handles: out };
}

// 협업 핸들 집합을 불러온다(캐시). 실패해도 마지막 성공 캐시를 유지한다 — 발송이 통째로 막히면 안 된다.
async function loadHandles() {
  if (cache.handles && Date.now() - cache.at < CACHE_MS) return cache;
  if (!configured()) { cache = { at: Date.now(), handles: cache.handles || new Set(), tabs: [], error: "GOOGLE_SERVICE_ACCOUNT 가 설정되지 않았습니다" }; return cache; }
  try {
    const token = await S.accessToken();
    const titles = await sheetTitles(token);
    const targets = titles.filter(t => TAB_KEYWORDS.some(k => t.toLowerCase().includes(k)));
    const set = new Set();
    const tabs = [];
    for (const t of targets) {
      const { handles, error } = await readTabHandles(token, t);
      handles.forEach(h => set.add(h));
      tabs.push({ tab: t, count: handles.length, error: error || undefined });
    }
    cache = { at: Date.now(), handles: set, tabs, error: targets.length ? "" : "대상 탭을 찾지 못했습니다 (INHOUSE_TABS 확인)" };
  } catch (e) {
    cache = { at: Date.now(), handles: cache.handles || new Set(), tabs: cache.tabs || [], error: String((e && e.message) || e) };
  }
  return cache;
}

async function handleSet() { return (await loadHandles()).handles || new Set(); }

async function summary() {
  const c = await loadHandles();
  const handles = [...(c.handles || new Set())].sort();
  return {
    configured: configured(), count: handles.length, handles,
    tabs: c.tabs, updatedAt: c.at ? new Date(c.at).toISOString() : "", error: c.error || undefined
  };
}

module.exports = { configured, loadHandles, handleSet, summary, extractHandle, colLetter, SHEET_ID };
