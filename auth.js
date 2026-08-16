// 직원 계정 · 로그인 세션
//
// 담당자마다 아이디/비밀번호를 주고, 네이버웍스 앱 비밀번호는 서버에만 둔다.
// 담당자는 앱 비밀번호를 알 필요가 없고, 브라우저에도 남지 않는다.
// 퇴사·교체 시 아래 목록에서 한 줄만 지우면 즉시 차단된다.
//
// ─── 환경변수 ────────────────────────────────────────────────────
//   NW_ACCOUNTS     직원 목록. 아래 두 형식 중 아무거나.
//   SESSION_SECRET  (선택) 세션 토큰 서명 키. 없으면 NW_ACCOUNTS 로부터 파생한다
//                   — 이 경우 직원 목록을 고치면 전원 재로그인이 필요하다.
//   SESSION_DAYS    (선택) 로그인 유지 기간, 기본 7일
//
// ─── 형식 1: 줄 단위 (권장 — Vercel 입력창에서 고치기 쉽다) ──────
//   아이디|로그인비번|표시이름|네이버웍스이메일|앱비밀번호|직함(선택)
//
//   hannie|Hann2026!|Hannie|hannie@dalbausa.com|abcd efgh ijkl mnop|Creator Partnerships
//   quinn|Qu1nnX!|Quinn|quinn@dalbausa.com|wxyz 1234 5678 9012|Creator Partnerships
//
//   · # 으로 시작하는 줄과 빈 줄은 무시된다
//   · 값에 | 를 쓸 수 없다 (비밀번호에 | 가 필요하면 형식 2를 쓸 것)
//
// ─── 형식 2: JSON ────────────────────────────────────────────────
//   [{"id":"hannie","pw":"...","name":"Hannie","email":"hannie@dalbausa.com",
//     "appPassword":"...","title":"Creator Partnerships"}]

const crypto = require("crypto");

const SESSION_DAYS = Number(process.env.SESSION_DAYS || 7);

// ─── 직원 목록 파싱 ──────────────────────────────────────────────
function parseAccounts() {
  const raw = (process.env.NW_ACCOUNTS || "").trim();
  if (!raw) return [];

  // 형식 2: JSON
  if (raw[0] === "[" || raw[0] === "{") {
    try {
      const arr = JSON.parse(raw);
      return (Array.isArray(arr) ? arr : [arr])
        .map(a => ({
          id: String(a.id || a.loginId || "").trim().toLowerCase(),
          pw: String(a.pw || a.password || a.loginPw || ""),
          name: String(a.name || "").trim(),
          email: String(a.email || "").trim().toLowerCase(),
          appPassword: String(a.appPassword || a.appPw || a.smtpPassword || ""),
          title: String(a.title || "").trim()
        }))
        .filter(a => a.id && a.pw && a.email && a.appPassword);
    } catch (_) { return []; }
  }

  // 형식 1: 줄 단위
  return raw.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && l[0] !== "#")
    .map(l => {
      const f = l.split("|").map(s => s.trim());
      return {
        id: (f[0] || "").toLowerCase(),
        pw: f[1] || "",
        name: f[2] || "",
        email: (f[3] || "").toLowerCase(),
        appPassword: f[4] || "",
        title: f[5] || ""
      };
    })
    .filter(a => a.id && a.pw && a.email && a.appPassword);
}

function enabled() { return parseAccounts().length > 0; }

// ─── 비밀번호 비교 ───────────────────────────────────────────────
// 길이가 달라도 시간차가 새지 않도록 해시를 고정 길이로 만든 뒤 비교한다.
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function findByLogin(id, pw) {
  const wanted = String(id || "").trim().toLowerCase();
  if (!wanted || !pw) return null;
  // 아이디가 틀려도 같은 시간이 들도록 전부 훑는다
  let found = null;
  for (const a of parseAccounts()) {
    if (a.id === wanted && safeEqual(a.pw, pw)) found = a;
  }
  return found;
}

function findByEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return parseAccounts().find(a => a.email === e) || null;
}

// ─── 세션 토큰 ───────────────────────────────────────────────────
// 서버리스라 세션을 저장할 곳이 없다. 서명된 토큰에 이메일과 만료시각만 담고
// 비밀번호류는 절대 넣지 않는다. 검증은 서명 + 만료 + 계정 존재 여부로 한다.
function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  // 별도 키를 안 넣었으면 계정 목록에서 파생한다.
  // 목록을 고치면 서명 키가 바뀌어 전원 재로그인이 필요하지만, 그게 더 안전하다.
  return crypto.createHash("sha256").update("nwsess:" + (process.env.NW_ACCOUNTS || "")).digest("hex");
}

const b64u = s => Buffer.from(s, "utf8").toString("base64url");
const unb64u = s => Buffer.from(String(s), "base64url").toString("utf8");

function makeToken(email) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const body = b64u(String(email).toLowerCase() + "|" + exp);
  const sig = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return body + "." + sig;
}

// 유효하면 해당 직원 계정 객체를, 아니면 null 을 돌려준다.
function verifyToken(token) {
  const t = String(token || "");
  const i = t.lastIndexOf(".");
  if (i < 1) return null;
  const body = t.slice(0, i), sig = t.slice(i + 1);

  const expect = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  let ok = false;
  try { ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect)); } catch (_) { return null; }
  if (!ok) return null;

  let email, exp;
  try { [email, exp] = unb64u(body).split("|"); } catch (_) { return null; }
  if (!email || !exp || Date.now() > Number(exp)) return null;

  // 토큰이 유효해도 계정이 지워졌으면 거부 — 퇴사 처리가 즉시 반영되도록
  return findByEmail(email);
}

// 요청에서 토큰을 꺼낸다 (헤더 우선, 쿼리도 허용)
function tokenFrom(req) {
  const h = req.headers || {};
  const auth = h.authorization || h.Authorization || "";
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  return h["x-session"] || (req.query && req.query.token) || "";
}

// 이 요청을 수행할 직원. 로그인 계정을 안 쓰는 배포면 null 을 돌려주고,
// 호출하는 쪽이 기존 방식(브라우저 자격증명)으로 넘어간다.
function currentUser(req) {
  if (!enabled()) return null;
  return verifyToken(tokenFrom(req));
}

// 화면에 내보내도 되는 정보만 (앱 비밀번호·로그인 비번은 절대 포함하지 않는다)
function publicUser(a) {
  return a ? { id: a.id, name: a.name || a.email.split("@")[0], email: a.email, title: a.title } : null;
}

module.exports = {
  enabled, parseAccounts, findByLogin, findByEmail,
  makeToken, verifyToken, tokenFrom, currentUser, publicUser,
  SESSION_DAYS
};
