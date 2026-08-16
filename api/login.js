// Vercel Serverless Function — 배포 경로: /api/login
//
//   GET  /api/login   → 이 배포가 어떤 인증 방식인지 알려준다 (화면이 로그인 폼을 띄울지 판단)
//   POST /api/login   → { id, pw } 로 로그인. 성공 시 세션 토큰과 표시용 정보 반환
//
// 직원 등록은 환경변수 NW_ACCOUNTS 로 한다 (형식은 auth.js 주석 참고).
// 네이버웍스 앱 비밀번호는 절대 응답에 담지 않는다 — 서버 밖으로 나가지 않는다.

const A = require("../auth.js");

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === "string") { try { return JSON.parse(b); } catch (_) { return {}; } }
  return b;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  // 화면이 어떤 로그인 UI 를 보여줄지 결정하는 용도.
  // 아이디 목록은 알려주지 않는다 (계정 열거 방지).
  if (req.method === "GET") {
    res.status(200).json({
      mode: A.enabled() ? "accounts" : "byo",
      sessionDays: A.SESSION_DAYS,
      // 계정을 몇 명 등록했는지만 — 설정이 먹었는지 확인용
      count: A.enabled() ? A.parseAccounts().length : 0
    });
    return;
  }

  if (req.method !== "POST") { res.status(405).json({ error: "method not allowed" }); return; }

  if (!A.enabled()) {
    res.status(501).json({ error: "직원 계정이 설정되지 않았습니다 (환경변수 NW_ACCOUNTS)" });
    return;
  }

  const { id, pw } = readBody(req);
  const user = A.findByLogin(id, pw);

  if (!user) {
    // 아이디가 없는 건지 비번이 틀린 건지 구분해 주지 않는다
    res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다" });
    return;
  }

  res.status(200).json({
    token: A.makeToken(user.email),
    user: A.publicUser(user),
    sessionDays: A.SESSION_DAYS
  });
};
