// 브랜드(테마)별 로고 — 발송(send-core.js)·리마인드(reminders.js)·미리보기(api/outreach-send.js)가 같이 쓴다.
//
//   dalba     logo-black.png     (기본 · 노랑 테마)
//   veganery  logo-veganery.png  (비거너리 by d'Alba · 연두 테마)
//
// 외부 URL 은 배포 보호 등으로 깨질 수 있어 파일을 메일 안에 담는다(cid 인라인 첨부).
// ⚠️ 파일 이름은 꼭 **글자 그대로** 적는다 — Vercel 이 코드에서 읽는 파일을 찾아 함께 배포하는데,
//    이름을 변수로 조립하면 못 찾아서 배포본에 로고가 빠진다.
// LOGO_URL 을 명시한 배포는 그 뜻을 존중해 d'Alba 로고는 인라인을 쓰지 않는다(비거너리는 항상 파일).
const fs = require("fs");
const path = require("path");

const THEMES = ["dalba", "veganery"];
const CID = { dalba: "dalbalogo@dalba", veganery: "veganerylogo@dalba" };
const FILE = { dalba: "logo-black.png", veganery: "logo-veganery.png" };

function themeOf(t) { return THEMES.includes(t) ? t : "dalba"; }

const cache = {};   // 테마 → Buffer | null
function logoBuffer(theme) {
  const t = themeOf(theme);
  if (cache[t] !== undefined) return cache[t];
  try {
    if (t === "veganery") cache[t] = fs.readFileSync(path.join(__dirname, "logo-veganery.png"));
    else cache[t] = process.env.LOGO_URL ? null : fs.readFileSync(path.join(__dirname, "logo-black.png"));
  } catch (_) { cache[t] = null; }
  return cache[t];
}
function logoDataUrl(theme) {
  const b = logoBuffer(theme);
  return b ? "data:image/png;base64," + b.toString("base64") : "";
}
function logoAttachment(theme) {
  const t = themeOf(theme), b = logoBuffer(t);
  return b ? { filename: "logo.png", content: b, contentType: "image/png", cid: CID[t], contentDisposition: "inline" } : null;
}
// 파일을 못 읽었을 때의 대안 — 배포 주소의 정적 파일
function logoUrl(theme) {
  const t = themeOf(theme);
  if (t === "dalba" && process.env.LOGO_URL) return process.env.LOGO_URL;
  const host = (process.env.VERCEL_PROJECT_PRODUCTION_URL || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return host ? "https://" + host + "/" + FILE[t] : "";
}

module.exports = { THEMES, CID, themeOf, logoBuffer, logoDataUrl, logoAttachment, logoUrl };
