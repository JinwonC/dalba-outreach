// Google 스프레드시트 읽기
//
// "US 제품별 콘텐츠 트래킹" 시트의 **영상성과** 탭에서 제품별 매출 상위 영상을 가져온다.
// TikTok Shop API 를 다시 부르지 않는다 — 그 집계는 이미 이 시트에 매일 쌓이고 있다.
//
// ─── 두 가지 접근 방법 ───────────────────────────────────────────
// 1) 서비스 계정 (권장) — 시트를 **비공개로 둔 채** 읽는다.
//      GOOGLE_SERVICE_ACCOUNT  서비스 계정 JSON 통째로
//      시트를 그 계정 이메일에 "뷰어" 로 공유해야 한다.
// 2) 웹에 게시한 CSV — 설정이 제일 쉽지만 **URL 을 아는 사람은 누구나 볼 수 있다.**
//      SHEET_CSV_URL  게시된 CSV 주소
//    크리에이터 핸들과 매출이 담긴 표라, 이 방법을 쓸지는 알고 골라야 한다.
//
// ─── 환경변수 ────────────────────────────────────────────────────
//   SHEET_ID    기본 1_qkd6LZ1wFoihhJSuYdabQ4iRbx-jsFYVxeGIoEb-_g
//   SHEET_TAB   기본 "영상성과_신API테스트"
//   SHEET_CSV_URL / GOOGLE_SERVICE_ACCOUNT  (둘 중 하나)

const crypto = require("crypto");

const SHEET_ID = process.env.SHEET_ID || "1_qkd6LZ1wFoihhJSuYdabQ4iRbx-jsFYVxeGIoEb-_g";
const SHEET_TAB = process.env.SHEET_TAB || "영상성과_신API테스트";
const CSV_URL = process.env.SHEET_CSV_URL || "";

const CACHE_MS = 30 * 60e3;   // 시트는 하루 한 번 갱신된다 — 30분 캐시로 충분하다
let cache = { at: 0, rows: null };

function serviceAccount() {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT || "").trim();
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    return (j.client_email && j.private_key) ? j : null;
  } catch (_) { return null; }
}

function configured() { return Boolean(CSV_URL || serviceAccount()); }

// ─── 서비스 계정 → 액세스 토큰 ───────────────────────────────────
// 서명한 JWT 를 토큰으로 바꿔 받는다(OAuth2 JWT bearer). 추가 패키지 없이 crypto 로 된다.
let tokenCache = { value: "", exp: 0 };

async function accessToken() {
  if (tokenCache.value && Date.now() < tokenCache.exp) return tokenCache.value;
  const sa = serviceAccount();
  if (!sa) throw new Error("GOOGLE_SERVICE_ACCOUNT 가 설정되지 않았습니다");

  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "RS256", typ: "JWT" });
  const body = b64({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600
  });
  const sig = crypto.createSign("RSA-SHA256").update(head + "." + body).end()
    .sign(sa.private_key.replace(/\\n/g, "\n"), "base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: head + "." + body + "." + sig
    })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("구글 인증 실패: " + (d.error_description || d.error || "알 수 없음"));
  tokenCache = { value: d.access_token, exp: Date.now() + (d.expires_in - 60) * 1000 };
  return tokenCache.value;
}

// ─── CSV 파싱 ────────────────────────────────────────────────────
// 따옴표 안의 콤마·줄바꿈까지 다뤄야 한다 — 시트 값에 흔히 들어 있다.
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ─── 시트 읽기 ───────────────────────────────────────────────────
// 필요한 건 F(핸들) · H(매출) · M(영상ID) · O(제품ID) 네 열뿐이다.
async function readRows() {
  if (cache.rows && Date.now() - cache.at < CACHE_MS) return cache.rows;

  let rows;
  if (serviceAccount()) {
    const token = await accessToken();
    // 한 번에 F~O 만 받는다 — 시트 전체는 17MB 라 통째로 받으면 안 된다
    const range = encodeURIComponent(`'${SHEET_TAB}'!F:O`);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}` +
                `?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`;
    const r = await fetch(url, { headers: { authorization: "Bearer " + token } });
    const d = await r.json();
    if (d.error) throw new Error("시트 읽기 실패: " + (d.error.message || ""));
    // F 부터 받았으므로 0=F, 2=H, 7=M, 9=O
    rows = (d.values || []).map(v => ({
      handle: String(v[0] == null ? "" : v[0]).trim(),
      gmv: Number(String(v[2] == null ? "" : v[2]).replace(/[^0-9.\-]/g, "")),
      videoId: String(v[7] == null ? "" : v[7]).trim(),
      pid: String(v[9] == null ? "" : v[9]).trim()
    }));
  } else if (CSV_URL) {
    const r = await fetch(CSV_URL);
    if (!r.ok) throw new Error("시트 CSV 를 읽지 못했습니다 (HTTP " + r.status + ")");
    const csv = parseCsv(await r.text());
    // 게시된 CSV 는 A 열부터 온다 — F=5, H=7, M=12, O=14
    rows = csv.map(v => ({
      handle: String(v[5] || "").trim(),
      gmv: Number(String(v[7] || "").replace(/[^0-9.\-]/g, "")),
      videoId: String(v[12] || "").trim(),
      pid: String(v[14] || "").trim()
    }));
  } else {
    throw new Error("시트 접근 방법이 설정되지 않았습니다 (GOOGLE_SERVICE_ACCOUNT 또는 SHEET_CSV_URL)");
  }

  // 헤더 줄과 빈 줄을 걷어낸다
  rows = rows.filter(r => r.pid && r.videoId && isFinite(r.gmv));
  cache = { at: Date.now(), rows };
  return rows;
}

// 제품 하나의 매출 상위 영상. 매출 1 미만은 아예 후보로 두지 않는다.
async function topVideos(pid, limit) {
  const want = String(pid || "").trim();
  if (!want) return [];
  const rows = await readRows();
  const n = Math.max(1, Math.min(Number(limit) || 20, 100));

  // 같은 영상이 여러 줄로 들어오는 경우가 있어 영상 ID 로 묶고 가장 큰 매출을 남긴다
  const best = new Map();
  rows.forEach(r => {
    if (r.pid !== want || !(r.gmv >= 1)) return;
    const cur = best.get(r.videoId);
    if (!cur || r.gmv > cur.gmv) best.set(r.videoId, r);
  });

  return [...best.values()]
    .sort((a, b) => b.gmv - a.gmv)
    .slice(0, n)
    .map(r => ({
      handle: r.handle.replace(/^@+/, ""),
      gmv: Math.round(r.gmv),
      videoId: r.videoId,
      url: r.handle ? `https://www.tiktok.com/@${r.handle.replace(/^@+/, "")}/video/${r.videoId}` : ""
    }))
    .filter(v => v.url);
}

module.exports = { configured, topVideos, readRows, parseCsv, SHEET_TAB, SHEET_ID };
