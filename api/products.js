// Vercel Serverless Function — 배포 경로: /api/products
//
// TikTok Shop 상품 목록을 가져와 아웃리치 화면의 상품 선택기에 넘긴다.
// 상품명 · 썸네일 · 가격 · 재고 · 판매상태(status) 를 반환한다.
//
//   GET /api/products             → 판매중(ACTIVATE) 상품만
//   GET /api/products?all=1       → 전체 상태 포함
//   GET /api/products?fresh=1     → 목록 캐시 무시하고 다시 조회
//   GET /api/products?debug=1     → 목록 응답의 원본 구조를 함께 반환
//   GET /api/products?debugDetail=1 → 상세 응답의 원본 구조를 함께 반환
//
// ─── 왜 CRUVA 가 아니라 TikTok Shop 직접인가 ─────────────────────
// CRUVA API 에는 상품 이미지 필드가 아예 없고, 상태도 의미가 문서화되지 않은
// 숫자 코드(1/3/4/6)로만 온다. TikTok Shop 원본 API 는 상품 이미지와
// 문자열 status("ACTIVATE" 등)를 함께 주므로 썸네일·판매중 판별이 한 번에 해결된다.
//
// ─── 환경변수 (Vercel) ───────────────────────────────────────────
//   TTS_APP_KEY        Partner Center → Manage apps → App key
//   TTS_APP_SECRET     같은 화면 → App secret
//   TTS_SHOP_CIPHER    샵별 식별자
//   TTS_REFRESH_TOKEN  샵 인증으로 발급받은 refresh token
//   (선택) TTS_ACCESS_TOKEN  있으면 첫 갱신 한 번을 아낀다
//   (선택) DASHBOARD_PASSWORD  설정 시 x-dashboard-password 헤더 또는 ?pw= 필요
//
// 네 값이 모두 없으면 이 엔드포인트는 501 을 돌려주고, 화면은 상품 선택기를
// 조용히 감춘다 — 자격증명 없이도 나머지 기능은 그대로 동작해야 하므로.

const crypto = require("crypto");

const BASE = "https://open-api.tiktokglobalshop.com";
const AUTH_BASE = "https://auth.tiktok-shops.com";
const SEARCH_PATH = "/product/202309/products/search";

const APP_KEY = process.env.TTS_APP_KEY || "";
const APP_SECRET = process.env.TTS_APP_SECRET || "";
const SHOP_CIPHER = process.env.TTS_SHOP_CIPHER || "";
const REFRESH_TOKEN = process.env.TTS_REFRESH_TOKEN || "";

const PAGE_SIZE = 100;      // API 상한
const MAX_PAGES = 10;       // 폭주 방지 (최대 1000개)
const CACHE_MS = 10 * 60e3; // 상품 목록은 자주 바뀌지 않는다

function configured() { return Boolean(APP_KEY && APP_SECRET && SHOP_CIPHER && (REFRESH_TOKEN || process.env.TTS_ACCESS_TOKEN)); }

// ─── 서명 ────────────────────────────────────────────────────────
// app_secret + path + (정렬된 파라미터 key+value 연결) + body + app_secret
// 을 app_secret 키로 HMAC-SHA256. sign 자신과 access_token 은 제외한다.
function sign(path, params, body) {
  let s = APP_SECRET + path;
  Object.keys(params).sort().forEach(k => { s += k + String(params[k]); });
  s += (body || "") + APP_SECRET;
  return crypto.createHmac("sha256", APP_SECRET).update(s).digest("hex");
}

// ─── 액세스 토큰 ─────────────────────────────────────────────────
// 서버리스라 디스크에 저장할 수 없다. 워밍된 인스턴스 동안만 메모리에 들고 있고,
// 콜드 스타트나 만료 시 refresh_token 으로 다시 받는다.
let tokenCache = { value: process.env.TTS_ACCESS_TOKEN || "", expiresAt: process.env.TTS_ACCESS_TOKEN ? Date.now() + 60e3 : 0 };

async function refreshAccessToken() {
  if (!REFRESH_TOKEN) throw new Error("TTS_REFRESH_TOKEN 이 설정되지 않았습니다");
  const qs = new URLSearchParams({
    app_key: APP_KEY, app_secret: APP_SECRET,
    refresh_token: REFRESH_TOKEN, grant_type: "refresh_token"
  });
  const r = await fetch(`${AUTH_BASE}/api/v2/token/refresh?${qs}`);
  const d = await r.json();
  if (d.code !== 0 || !d.data || !d.data.access_token) {
    throw new Error(`토큰 갱신 실패: code=${d.code} ${d.message || ""}`);
  }
  // TikTok 이 갱신 때마다 새 refresh_token 을 주더라도 여기서는 저장할 곳이 없다.
  // 기존 refresh_token 이 계속 유효한 전제로 동작한다(dalba-check 이 수개월간 그렇게 동작해 왔다).
  // 어느 날 갱신이 실패하기 시작하면 Vercel 환경변수의 TTS_REFRESH_TOKEN 을 새로 발급해 넣어야 한다.
  const ttl = Number(d.data.access_token_expire_in || 0);
  tokenCache = {
    value: d.data.access_token,
    // 만료 5분 전에 미리 갱신. 만료시간을 안 주면 1시간으로 가정.
    expiresAt: Date.now() + (ttl ? Math.max(ttl - 300, 60) * 1000 : 3600e3)
  };
  return tokenCache.value;
}

async function getAccessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;
  return refreshAccessToken();
}

// ─── 상품 상세 (썸네일은 여기에만 있다) ──────────────────────────
// products/search 응답 필드는 create_time/id/recommended_categories/sales_regions/
// skus/status/title/update_time 뿐이고 이미지가 없다. 이미지는 상품 상세 API 에만
// 들어 있어 상품마다 한 번씩 더 불러야 한다. 카탈로그는 자주 바뀌지 않으므로
// 상품 ID 별로 오래 캐시해 재조회를 피한다.
const DETAIL_TTL = 24 * 3600e3;
const imageCache = new Map();   // id -> { url, at }

async function fetchDetailImage(id, token) {
  const hit = imageCache.get(id);
  if (hit && Date.now() - hit.at < DETAIL_TTL) return hit.url;

  const path = `/product/202309/products/${id}`;
  const params = {
    app_key: APP_KEY,
    shop_cipher: SHOP_CIPHER,
    timestamp: String(Math.floor(Date.now() / 1000))
  };
  params.sign = sign(path, params, "");

  let url = "";
  try {
    const r = await fetch(`${BASE}${path}?${new URLSearchParams(params)}`, {
      headers: { "x-tts-access-token": token }
    });
    const d = await r.json();
    if (d.code === 0) url = rawImage(d.data || {});
  } catch (_) { /* 개별 실패는 무시 */ }

  // 실패해도 빈 값을 캐시한다 — 한 상품 때문에 매 요청마다 재시도하지 않도록
  imageCache.set(id, { url, at: Date.now() });
  return url;
}

// 상품이 100개가 넘어 순차로 돌면 함수 제한시간을 넘긴다. 동시 8개로 묶고,
// 마감시간을 넘기면 거기까지만 채운다(다음 요청이 캐시 위에서 이어받는다).
async function enrichImages(items, token, deadline) {
  const queue = items.filter(p => p.id && !p.image);
  let i = 0;
  const worker = async () => {
    while (i < queue.length && Date.now() < deadline) {
      const p = queue[i++];
      const url = await fetchDetailImage(p.id, token);
      if (url) { p.imageOrig = url; p.image = toJpeg(url); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker));
}

// ─── 상품 검색 1페이지 ───────────────────────────────────────────
async function searchPage(pageToken, token) {
  const bodyObj = pageToken ? { page_token: pageToken } : {};
  const body = pageToken ? JSON.stringify(bodyObj) : "";

  const params = {
    app_key: APP_KEY,
    shop_cipher: SHOP_CIPHER,
    timestamp: String(Math.floor(Date.now() / 1000)),
    page_size: String(PAGE_SIZE)
  };
  params.sign = sign(SEARCH_PATH, params, body);

  const r = await fetch(`${BASE}${SEARCH_PATH}?${new URLSearchParams(params)}`, {
    method: "POST",
    headers: { "x-tts-access-token": token, "content-type": "application/json" },
    body: body || undefined
  });
  return r.json();
}

// ─── 응답 정규화 ─────────────────────────────────────────────────
// 상품 하나에서 화면에 필요한 것만 뽑는다. API 필드 모양이 조금씩 달라도
// 깨지지 않도록 방어적으로 접근한다.
//
// 이미지 필드 이름은 API 버전마다 다르고(main_images / images / product_images …),
// 그 안의 URL 배열 키도 urls / url_list 등으로 갈린다. 이름을 하나로 가정하면
// 어긋나는 순간 썸네일이 통째로 비므로, ① 알려진 경로를 먼저 보고
// ② 못 찾으면 응답 객체를 훑어 이미지처럼 생긴 CDN URL 을 집는다.
function looksLikeImageUrl(u) {
  if (typeof u !== "string" || !/^https?:\/\//i.test(u)) return false;
  return /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(u) ||
         /tplv-|\/tos-|ibyteimg|ttcdn|tiktokcdn|byteimg/i.test(u);
}

function deepFindImage(o, depth) {
  if (!o || depth > 8) return "";
  if (typeof o === "string") return looksLikeImageUrl(o) ? o : "";
  if (Array.isArray(o)) {
    for (const x of o) { const r = deepFindImage(x, depth + 1); if (r) return r; }
    return "";
  }
  if (typeof o === "object") {
    // 이미지로 보이는 키를 먼저 훑어 엉뚱한 URL 을 집을 확률을 낮춘다
    const score = k => (/image|img|thumb|cover|pic|url/i.test(k) ? 0 : 1);
    for (const k of Object.keys(o).sort((a, b) => score(a) - score(b))) {
      const r = deepFindImage(o[k], depth + 1);
      if (r) return r;
    }
  }
  return "";
}

function rawImage(p) {
  for (const key of ["main_images", "images", "product_images", "main_image", "cover_image"]) {
    const v = p[key];
    if (!v) continue;
    const r = deepFindImage(v, 0);
    if (r) return r;
  }
  return deepFindImage(p, 0);
}

// TikTok CDN 은 같은 경로에서 .webp / .jpeg 를 모두 내주는 경우가 많다.
// 메일 클라이언트 호환(Outlook 등은 webp 미지원)을 위해 jpeg 를 우선하되,
// 그 변형이 없는 템플릿도 있으므로 원본 URL 을 함께 돌려주고 화면에서 대체하게 한다.
function toJpeg(u) {
  return u ? String(u).replace(/\.webp(\?|$)/i, ".jpeg$1") : "";
}

function pickPrice(p) {
  const skus = p.skus || [];
  for (const s of skus) {
    const pr = s && s.price;
    if (!pr) continue;
    const amt = pr.sale_price || pr.tax_exclusive_price || pr.original_price;
    if (amt) return { price: String(amt), currency: pr.currency || "USD" };
  }
  return { price: "", currency: "USD" };
}

function pickStock(p) {
  let n = 0;
  (p.skus || []).forEach(s => {
    (s.inventory || []).forEach(w => {
      n += Number(w.quantity != null ? w.quantity : (w.available_quantity || 0)) || 0;
    });
  });
  return n;
}

function normalize(p) {
  const { price, currency } = pickPrice(p);
  const orig = rawImage(p);   // 목록 응답에는 보통 없다. 상세에서 채운다.
  return {
    id: String(p.id || ""),
    title: p.title || p.product_name || "",
    status: String(p.status || ""),          // ACTIVATE / SELLER_DEACTIVATED / DELETED / FREEZE
    image: toJpeg(orig),                     // 메일용 (jpeg 우선)
    imageOrig: orig,                         // 화면용 대체 — jpeg 변형이 없는 템플릿 대비
    price, currency,
    stock: pickStock(p),
    url: p.id ? `https://shop.tiktok.com/view/product/${p.id}` : ""
  };
}

// ─── 전체 페이지 수집 ────────────────────────────────────────────
let listCache = { at: 0, items: null, raw: null };

async function fetchAll() {
  let token = await getAccessToken();
  const items = [];
  let pageToken = null, pages = 0, firstRaw = null, refreshed = false;

  while (pages < MAX_PAGES) {
    let d = await searchPage(pageToken, token);

    // 105002 = 액세스 토큰 만료. 한 번만 갱신 후 재시도한다.
    if (d.code === 105002 && !refreshed) {
      refreshed = true;
      token = await refreshAccessToken();
      d = await searchPage(pageToken, token);
    }
    if (d.code !== 0) {
      throw new Error(`TikTok Shop API 오류: code=${d.code} ${d.message || ""}`);
    }

    const products = (d.data && d.data.products) || [];
    if (!firstRaw && products[0]) firstRaw = products[0];
    products.forEach(p => items.push(normalize(p)));

    const next = (d.data && d.data.next_page_token) || "";
    pages++;
    if (!next || next === pageToken) break;
    pageToken = next;
  }

  return { items, firstRaw };
}

module.exports = async (req, res) => {
  try {
    const PW = process.env.DASHBOARD_PASSWORD;
    if (PW) {
      const given = req.headers["x-dashboard-password"] || (req.query && req.query.pw) || "";
      if (given !== PW) { res.status(401).json({ error: "unauthorized" }); return; }
    }

    // 자격증명이 없으면 기능만 꺼진다 — 화면의 나머지는 그대로 써야 하므로 에러로 죽이지 않는다.
    if (!configured()) {
      res.setHeader("Cache-Control", "no-store");
      res.status(501).json({
        error: "TikTok Shop 자격증명이 설정되지 않았습니다",
        need: ["TTS_APP_KEY", "TTS_APP_SECRET", "TTS_SHOP_CIPHER", "TTS_REFRESH_TOKEN"]
          .filter(k => !process.env[k])
      });
      return;
    }

    const q = req.query || {};
    // 화면이 상품 선택 버튼을 띄울지만 판단하는 용도.
    // 여기서 상품을 실제로 조회하면 페이지 열 때마다 TikTok API 를 때리게 되므로 설정 여부만 답한다.
    if (q.probe === "1") {
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ ready: true });
      return;
    }

    const fresh = q.fresh === "1";
    const all = q.all === "1";

    if (fresh || !listCache.items || Date.now() - listCache.at > CACHE_MS) {
      const { items, firstRaw } = await fetchAll();
      listCache = { at: Date.now(), items, raw: firstRaw };
    }

    let items = listCache.items;
    // 판매중만 — status 가 문자열로 오므로 추측 없이 정확히 거를 수 있다.
    if (!all) items = items.filter(p => p.status.toUpperCase() === "ACTIVATE");
    // 잘 팔리는 순서가 없으므로 재고 있는 것 우선 + 이름순
    items = items.slice().sort((a, b) =>
      (b.stock > 0) - (a.stock > 0) || a.title.localeCompare(b.title));

    // 썸네일은 상세 API 에서만 오므로 반환할 목록에 대해서만 채운다.
    // (전체가 아니라 실제로 보여줄 것만 — 불필요한 호출을 줄인다)
    await enrichImages(items, await getAccessToken(), Date.now() + 40e3);

    // 진단용: 상세 응답이 실제로 어떤 모양인지 확인
    let debugDetail;
    if (q.debugDetail === "1" && items[0]) {
      const path = `/product/202309/products/${items[0].id}`;
      const dp = { app_key: APP_KEY, shop_cipher: SHOP_CIPHER, timestamp: String(Math.floor(Date.now() / 1000)) };
      dp.sign = sign(path, dp, "");
      const rr = await fetch(`${BASE}${path}?${new URLSearchParams(dp)}`, {
        headers: { "x-tts-access-token": await getAccessToken() }
      });
      const dd = await rr.json();
      debugDetail = { code: dd.code, message: dd.message, keys: Object.keys(dd.data || {}), data: dd.data };
    }

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      updated: new Date(listCache.at).toISOString(),
      total: listCache.items.length,
      returned: items.length,
      statuses: [...new Set(listCache.items.map(p => p.status))],
      withImage: items.filter(p => p.image).length,   // 썸네일 진단용
      products: items,
      ...(debugDetail ? { debugDetail } : {}),
      ...(q.debug === "1" ? { debugFirstRawKeys: Object.keys(listCache.raw || {}), debugFirstRaw: listCache.raw } : {})
    });
  } catch (e) {
    res.status(502).json({
      error: String((e && e.message) || e),
      hint: "Vercel 환경변수 TTS_APP_KEY / TTS_APP_SECRET / TTS_SHOP_CIPHER / TTS_REFRESH_TOKEN 값을 확인하세요. " +
            "refresh token 이 만료됐다면 Partner Center 에서 앱을 다시 Authorize 하고 새 토큰을 넣어야 합니다."
    });
  }
};
