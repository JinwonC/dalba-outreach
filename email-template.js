/*!
 * 달바 크리에이터 아웃리치 — 이메일 템플릿 엔진
 *
 * 브라우저(index.html 실시간 미리보기)와 서버(api/outreach-send.js 실제 발송)가
 * **같은 코드**를 쓰도록 UMD 로 작성했다. 미리보기와 실제 발송 메일이 어긋나면 안 되므로
 * 템플릿은 반드시 이 파일 한 곳에서만 만든다.
 *
 *   브라우저:  <script src="/email-template.js"></script> → window.OutreachTemplate
 *   서버:      const T = require("../email-template.js");
 *
 * 이메일 클라이언트 호환을 위해 <table> 레이아웃 + 인라인 CSS 로 만든다.
 * flex/grid 는 쓰지 않는다 — 상당수 클라이언트가 무시한다.
 * <style> 블록은 **여백을 줄이는 모바일 보정에만** 쓴다. 지원하지 않는 클라이언트가
 * 아직 있으므로, 그 블록이 통째로 무시돼도 레이아웃이 이미 성립해야 한다(MOBILE_CSS 참고).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OutreachTemplate = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ─── 디자인 토큰 ────────────────────────────────────────────────
  // 브랜드 배너의 노랑→크림 그라데이션(위 노랑, 아래 크림)과 검정 로고에서 뽑았다.
  const C = {
    page: "#f6efdd",      // 바깥 배경 (배너 아래쪽 크림)
    card: "#ffffff",      // 본문 카드
    dark: "#171717",      // CTA 버튼 · 검정 로고
    onDark: "#ffffff",    // 검정 버튼 위 텍스트
    gold: "#a9781a",      // 강조 (흰 카드 위에서 읽히도록 노랑보다 진한 앰버)
    box: "#fbf4e2",       // 안내 박스 배경
    boxLine: "#ecd9a6",   // 안내 박스 테두리
    text: "#1d1d1f",
    muted: "#6b6b6b",
    line: "#ececec",
    // 헤더 그라데이션 — 지원 안 하는 클라이언트는 heroFallback(단색 노랑)으로 떨어진다
    heroTop: "#f7d24e",
    heroMid: "#f4c842",
    heroBot: "#fbf1d3",
    heroFallback: "#f4c842",
    ink: "#171717",       // 노랑 위 검정 텍스트 (로고·제목)
    inkSoft: "#6b551d"    // 노랑 위 보조 텍스트 (배지·부제) — 노랑에서도 읽히는 짙은 갈색
  };
  const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'Apple SD Gothic Neo','Malgun Gothic',sans-serif";
  const WIDTH = 600;

  // ─── 모바일 대응 ────────────────────────────────────────────────
  // 두 겹으로 만든다. 미디어 쿼리를 지원하지 않는 클라이언트가 아직 있기 때문에
  // **미디어 쿼리 없이도 이미 화면에 들어와야** 하고, 쿼리는 여백을 더 줄이는 보정만 한다.
  //
  //   1겹(필수) — 바깥 틀을 width:100% + max-width:600px 로 둔다.
  //     예전에는 width="600" 이 박혀 있어서 좁은 화면에서 잘렸다. 표 너비 속성은
  //     max-width 를 모르는 클라이언트에서 그대로 이겨 버린다.
  //   2겹(보정) — 아래 CSS 로 여백·글자 크기를 줄이고 버튼을 가로로 채운다.
  //
  // Outlook 데스크톱(Word 엔진)은 max-width 를 무시해 본문이 창 너비만큼 늘어난다.
  // 그래서 MSO 전용 주석으로 600px 고정 표를 하나 더 감싼다(고스트 테이블).
  const MOBILE_CSS =
    "@media only screen and (max-width:620px){" +
    ".gut{padding:12px 8px 26px!important}" +
    ".hd{padding:26px 16px!important}" +
    ".card{padding:24px 16px 26px!important}" +
    ".bx{padding:18px 14px!important}" +
    ".h1{font-size:21px!important;line-height:1.3!important}" +
    ".big{font-size:27px!important}" +
    // 버튼은 손가락으로 누르는 것이라 좁은 화면에서 가로를 꽉 채운다
    ".cta{width:100%!important}" +
    ".cta a{display:block!important;padding:15px 20px!important}" +
    "}";

  // ─── 유틸 ──────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  // 링크는 스킴을 화이트리스트로 검증 (javascript: 등 주입 차단)
  function safeUrl(u) {
    const s = String(u == null ? "" : u).trim();
    if (!s) return "";
    if (/^(https?:|mailto:)/i.test(s)) return esc(s);
    if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(s)) return esc("https://" + s); // 스킴 생략 입력 보정
    return "";
  }
  function nl2br(s) { return esc(s).replace(/\r?\n/g, "<br />"); }
  function has(s) { return String(s == null ? "" : s).trim() !== ""; }

  // 콤마·세미콜론·공백·줄바꿈으로 구분된 이메일 목록 → 유효한 주소만, 중복 없이.
  // 참조(CC)를 미리보기와 발송이 똑같이 해석하도록 한 곳에 둔다.
  function parseList(s) {
    const out = [];
    String(s == null ? "" : s).split(/[,;\s]+/).forEach(function (x) {
      const e = x.trim().toLowerCase();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && out.indexOf(e) === -1) out.push(e);
    });
    return out;
  }

  // 이미지 src — http(s) URL, 메일 인라인 첨부(cid:), 미리보기용 data URL 셋 다 받는다.
  // cid 는 메일 안에 담긴 첨부라 외부 요청이 없어 절대 깨지지 않는다.
  // data URL 은 콤마 뒤가 base64 문자뿐인지 전체를 검사해 따옴표 주입을 막는다.
  function mediaSrc(s) {
    const v = String(s == null ? "" : s).trim();
    if (!v) return "";
    if (/^cid:[\w.@-]+$/i.test(v)) return v;
    if (/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(v)) return v.replace(/\s+/g, "");
    return safeUrl(v);
  }

  function money(currency, amount) {
    const cur = (currency || "USD").toUpperCase();
    const n = Number(String(amount).replace(/[^0-9.-]/g, ""));
    if (!isFinite(n) || !n) return "";
    // 통화 기호가 아니라 코드로 적는다: "USD 500"
    // (₩ 는 가로 이중선이 숫자에 취소선처럼 겹쳐 보이고, $ 는 어느 나라 달러인지 모호하다)
    return cur + " " + n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }

  // {{name}} {{handle}} {{brand}} … 치환 (제목·본문 커스텀 문구용)
  function fill(tpl, vars) {
    return String(tpl == null ? "" : tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, function (m, k) {
      return vars[k] != null && vars[k] !== "" ? String(vars[k]) : "";
    });
  }

  // ─── 조각 빌더 ─────────────────────────────────────────────────
  function sectionLabel(emoji, text) {
    return '<tr><td style="padding:30px 0 10px;font:700 11.5px/1.4 ' + FONT +
      ';letter-spacing:.14em;text-transform:uppercase;color:' + C.gold + ';">' +
      esc(emoji) + " " + esc(text) + "</td></tr>";
  }

  function infoBox(inner, opts) {
    const o = opts || {};
    return '<tr><td style="padding:0;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
      'style="background:' + C.box + ';border:1px solid ' + C.boxLine + ';border-radius:12px;">' +
      '<tr><td class="bx" style="padding:' + (o.pad || "22px 24px") + ';text-align:' + (o.align || "center") + ';">' +
      inner + "</td></tr></table></td></tr>";
  }

  function para(html) {
    return '<tr><td style="padding:0 0 16px;font:400 15px/1.65 ' + FONT + ';color:' + C.text + ';">' +
      html + "</td></tr>";
  }

  // ─── 보상 블록 (유상 / 어필리에이트 / 둘 다) ────────────────────
  function rewardBlocks(d) {
    const type = d.dealType || "paid";
    const wantPaid = type === "paid" || type === "both";
    const wantAff = type === "affiliate" || type === "both";
    let out = "";

    if (wantPaid && has(d.amount)) {
      out += infoBox(
        '<div style="font:700 11.5px/1.4 ' + FONT + ';letter-spacing:.14em;text-transform:uppercase;color:' + C.gold + ';">' +
        "💰 Cash paid to you</div>" +
        '<div class="big" style="font:800 34px/1.2 ' + FONT + ';color:' + C.text + ';padding:10px 0 6px;">' +
        esc(money(d.currency, d.amount)) + "</div>" +
        '<div style="font:400 13px/1.5 ' + FONT + ';color:' + C.muted + ';">' +
        esc(has(d.paymentNote) ? d.paymentNote : "Paid after your content goes live and is approved.") +
        "</div>"
      );
    }

    if (wantAff && has(d.commission)) {
      const rate = Number(String(d.commission).replace(/[^0-9.]/g, ""));
      out += (wantPaid && has(d.amount) ? '<tr><td style="height:12px;line-height:12px;">&nbsp;</td></tr>' : "");
      out += infoBox(
        '<div style="font:700 11.5px/1.4 ' + FONT + ';letter-spacing:.14em;text-transform:uppercase;color:' + C.gold + ';">' +
        "📈 Affiliate commission</div>" +
        '<div class="big" style="font:800 34px/1.2 ' + FONT + ';color:' + C.text + ';padding:10px 0 6px;">' +
        esc(rate ? rate + "%" : String(d.commission)) + "</div>" +
        '<div style="font:400 13px/1.5 ' + FONT + ';color:' + C.muted + ';">' +
        "On every sale made through your TikTok Shop affiliate link — " +
        (has(d.commissionNote) ? esc(d.commissionNote) : "no cap, paid out by TikTok Shop.") +
        "</div>"
      );
    }

    // 유상 + 어필리에이트 동시 제안이면 합산 메시지로 한 번 더 각인
    if (wantPaid && wantAff && has(d.amount) && has(d.commission)) {
      out += '<tr><td style="padding:12px 4px 0;font:600 13.5px/1.6 ' + FONT + ';color:' + C.text + ';text-align:center;">' +
        // 통화 기호(₩ 등) 대신 코드 표기를 쓴다 — ₩ 의 가로 이중선이 숫자에 취소선처럼 겹쳐 보임
        "You get <span style=\"color:" + C.gold + ";\">" + esc(money(d.currency, d.amount)) + " flat</span>" +
        " <span style=\"color:" + C.muted + ";font-weight:400;\">+</span> " +
        "<span style=\"color:" + C.gold + ";\">" + esc(String(d.commission).replace(/[^0-9.]/g, "")) + "% of every sale</span>." +
        "</td></tr>";
    }
    return out;
  }

  // ─── 캠페인 상세 (요구 산출물 / 마감 / 장소) ────────────────────
  function detailRows(d) {
    const rows = [];
    if (has(d.deliverables)) rows.push(["📹 What we'd love from you", nl2br(d.deliverables)]);
    if (has(d.deadline)) rows.push(["🗓 Timeline", nl2br(d.deadline)]);
    if (has(d.location)) rows.push(["📍 Location", nl2br(d.location)]);
    if (!rows.length) return "";

    let inner = '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">';
    rows.forEach(function (r, i) {
      inner += "<tr><td style=\"padding:" + (i ? "16px" : "0") + " 0 0;\">" +
        '<div style="font:700 12px/1.4 ' + FONT + ';color:' + C.muted + ';padding-bottom:5px;">' + esc(r[0]) + "</div>" +
        '<div style="font:400 14.5px/1.6 ' + FONT + ';color:' + C.text + ';">' + r[1] + "</div>" +
        "</td></tr>";
    });
    inner += "</table>";

    return sectionLabel("📦", "Campaign details") + infoBox(inner, { align: "left", pad: "20px 24px" });
  }

  // 제품 이미지 주소. 세 가지를 받는다:
  //   cid:…       서버가 메일에 인라인 첨부한 이미지 (링크 없이 파일로 붙일 때)
  //   data:image  브라우저 미리보기용 (업로드한 파일을 그 자리서 보여줄 때)
  //   http(s)     일반 이미지 URL
  // data URL 은 콤마 뒤가 base64 문자뿐인지 전체를 검사해서 따옴표 주입을 막는다.
  function productImgSrc(d) {
    if (has(d.productImageCid)) return mediaSrc("cid:" + String(d.productImageCid).replace(/[^\w.@-]/g, ""));
    return mediaSrc(d.productImageData) || safeUrl(d.productImage);
  }

  // ─── 제품 소개 ─────────────────────────────────────────────────
  function productBlock(d) {
    if (!has(d.product) && !has(d.productDesc)) return "";
    const url = safeUrl(d.productUrl);
    const img = productImgSrc(d);
    let inner = "";

    if (img) {
      inner += '<div style="padding-bottom:16px;"><img src="' + img + '" width="180" alt="' + esc(d.product) +
        '" style="width:180px;max-width:100%;height:auto;border-radius:10px;display:block;margin:0 auto;" /></div>';
    }
    if (has(d.product)) {
      inner += '<div style="font:700 16px/1.4 ' + FONT + ';color:' + C.text + ';padding-bottom:8px;">' + esc(d.product) + "</div>";
    }
    if (has(d.productDesc)) {
      inner += '<div style="font:400 14.5px/1.65 ' + FONT + ';color:' + C.text + ';">' + nl2br(d.productDesc) + "</div>";
    }
    if (url) {
      inner += '<div style="padding-top:14px;"><a href="' + url + '" style="font:700 14px/1.5 ' + FONT +
        ";color:" + C.gold + ';text-decoration:none;">' + esc(has(d.productUrlLabel) ? d.productUrlLabel : "See the product →") + "</a></div>";
    }
    return sectionLabel("🧴", "About " + (has(d.brand) ? d.brand : "the product")) +
      infoBox(inner, { align: img ? "center" : "left", pad: "22px 24px" });
  }

  // ─── 바이럴 영상 (이미 잘 되고 있다는 증거 — 수락률에 가장 크게 기여) ──
  // videos: ["https://...", ...] 또는 [{url, label}, ...] 둘 다 허용
  // 링크 주소를 화면에 그대로 찍으면 폰에서 세 줄로 접히며 밑줄 덩어리가 된다.
  // 눌러야 할 곳은 제목이므로, 주소는 알아볼 정도로만 줄여서 보조로 붙인다.
  function shortUrl(u) {
    const s = String(u == null ? "" : u).trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "");
    return s.length > 38 ? s.slice(0, 36) + "…" : s;
  }

  function normVideos(v) {
    if (!v) return [];
    const arr = Array.isArray(v) ? v : String(v).split(/[\n,]+/);
    return arr.map(function (x) {
      const o = (x && typeof x === "object") ? x : { url: x };
      return { url: safeUrl(o.url), short: esc(shortUrl(o.url)), label: has(o.label) ? o.label : "" };
    }).filter(function (o) { return o.url; }).slice(0, 4);
  }

  function videoBlock(d) {
    const vids = normVideos(d.videos);
    if (!vids.length) return "";

    let inner = '<div style="font:400 14.5px/1.65 ' + FONT + ";color:" + C.text + ';padding-bottom:14px;">' +
      esc(has(d.videosNote) ? d.videosNote : "Here's how this product is already performing with creators:") + "</div>" +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">';

    vids.forEach(function (v, i) {
      inner += "<tr>" +
        '<td width="30" valign="top" style="padding:' + (i ? "12px" : "0") + ' 10px 0 0;font:800 15px/1.5 ' + FONT +
        ";color:" + C.gold + ';">' + "▶" + "</td>" +
        '<td valign="top" style="padding:' + (i ? "12px" : "0") + ' 0 0;">' +
        '<a href="' + v.url + '" style="font:600 14px/1.5 ' + FONT + ";color:" + C.gold +
        ';text-decoration:none;word-break:break-word;">' + (v.label ? esc(v.label) : v.short) + "</a>" +
        (v.label ? '<div style="font:400 11.5px/1.5 ' + FONT + ";color:" + C.muted +
          ';padding-top:2px;">' + v.short + "</div>" : "") +
        "</td></tr>";
    });
    inner += "</table>";

    return sectionLabel("🔥", "Videos that are already popping off") +
      infoBox(inner, { align: "left", pad: "20px 24px" });
  }

  // ─── NEXT STEPS — 크리에이터가 답장에 무엇을 담아야 하는지 ──────
  const DEFAULT_STEPS_INTRO = "If you're interested, please share:";
  const DEFAULT_STEPS = [
    "A quick reply letting us know you're in — we'll send over the full collaboration details.",
    "Your WhatsApp number, or whichever contact method you prefer, for quick coordination."
  ];

  function stepsBlock(d) {
    const steps = (Array.isArray(d.steps) ? d.steps : DEFAULT_STEPS).filter(has);
    if (!steps.length) return "";
    const intro = has(d.stepsIntro) ? d.stepsIntro : DEFAULT_STEPS_INTRO;

    let inner = '<div style="font:400 14.5px/1.65 ' + FONT + ";color:" + C.text + ';padding-bottom:16px;">' +
      nl2br(intro) + "</div>" +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">';

    steps.forEach(function (s, i) {
      inner += "<tr>" +
        '<td width="36" valign="top" style="padding:' + (i ? "14px" : "0") + ' 12px 0 0;">' +
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
        '<td width="26" height="26" align="center" valign="middle" style="width:26px;height:26px;background:' + C.gold +
        ";border-radius:13px;font:700 12px/26px " + FONT + ';color:#fff;">' + (i + 1) + "</td>" +
        "</tr></table></td>" +
        '<td valign="top" style="padding:' + (i ? "14px" : "0") + ' 0 0;font:600 14.5px/1.6 ' + FONT + ";color:" + C.text + ';">' +
        nl2br(s) + "</td></tr>";
    });
    inner += "</table>";

    return sectionLabel("📋", "Next steps") + infoBox(inner, { align: "left", pad: "22px 24px" });
  }

  // ─── CTA 버튼 ──────────────────────────────────────────────────
  function ctaBlock(d) {
    const url = safeUrl(d.applyUrl);
    if (!url) return "";
    const label = has(d.applyLabel) ? d.applyLabel : "Count me in →";
    // 좁은 화면에서는 버튼이 가로를 채우도록 표 자체를 100% 로 넓힌다(.cta)
    return '<tr><td align="center" style="padding:34px 0 6px;">' +
      '<table role="presentation" class="cta" cellpadding="0" cellspacing="0" border="0"><tr>' +
      '<td align="center" style="background:' + C.dark + ';border-radius:999px;">' +
      '<a href="' + url + '" style="display:inline-block;padding:15px 46px;font:700 15px/1.2 ' + FONT +
      ';color:#ffffff;text-decoration:none;border-radius:999px;">' + esc(label) + "</a>" +
      "</td></tr></table></td></tr>";
  }

  // ─── 추가 안내 박스 (선택) ─────────────────────────────────────
  // 메일 하단에 담당자가 직접 만든 안내 박스를 넣는다 (예: 선물 폼, 디스코드 초대).
  // 각 박스는 제목·내용·버튼이름·버튼URL 을 담당자가 직접 채우고, 체크박스로 넣을지 고른다.
  // extras: [{ enabled, title, body, buttonLabel, buttonUrl }, ...]
  function extraButton(label, url) {
    const u = safeUrl(url);
    if (!u) return "";
    // 박스 안 버튼은 왼쪽 정렬(참고 디자인과 동일) · 좁은 화면에서 눌리기 쉬운 크기
    return '<div style="padding-top:16px;">' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
      '<td align="center" style="background:' + C.dark + ';border-radius:999px;">' +
      '<a href="' + u + '" style="display:inline-block;padding:13px 30px;font:700 14px/1.2 ' + FONT +
      ';color:#ffffff;text-decoration:none;border-radius:999px;">' + esc(has(label) ? label : "Learn more →") + "</a>" +
      "</td></tr></table></div>";
  }

  function normExtras(v) {
    if (!Array.isArray(v)) return [];
    // 켜짐 + 최소 한 가지(제목·내용·버튼)라도 있는 것만. 최대 4개.
    return v.filter(function (x) {
      return x && x.enabled && (has(x.title) || has(x.body) || safeUrl(x.buttonUrl));
    }).slice(0, 4);
  }

  function extrasBlock(d) {
    const items = normExtras(d.extras);
    if (!items.length) return "";
    let out = "";
    items.forEach(function (x, i) {
      let inner = "";
      if (has(x.title)) {
        inner += '<div style="font:700 12px/1.4 ' + FONT +
          ';letter-spacing:.12em;text-transform:uppercase;color:' + C.gold + ';padding-bottom:10px;">' +
          esc(x.title) + "</div>";
      }
      if (has(x.body)) {
        inner += '<div style="font:400 14.5px/1.65 ' + FONT + ";color:" + C.text + ';">' + nl2br(x.body) + "</div>";
      }
      inner += extraButton(x.buttonLabel, x.buttonUrl);
      out += (i ? '<tr><td style="height:12px;line-height:12px;">&nbsp;</td></tr>' : "") +
        infoBox(inner, { align: "left", pad: "22px 24px" });
    });
    return out;
  }

  // ─── 메일 전체 ─────────────────────────────────────────────────
  function buildHtml(d) {
    d = resolve(d);
    const creator = has(d.creatorName) ? d.creatorName : (has(d.handle) ? "@" + String(d.handle).replace(/^@/, "") : "there");
    const brand = has(d.brand) ? d.brand : "d'Alba";
    const title = has(d.campaignTitle) ? d.campaignTitle : "Paid Collab Invitation";

    // 로고 — 호스팅한 로고 이미지(logoUrl)가 있으면 그걸 쓰고,
    // 없으면 d'Alba 워드마크를 텍스트로 그린다. 실제 로고를 본뜬 세리프체 "d'Alba" +
    // 자간을 넓힌 "piedmont" 태그라인이다. 이메일은 이미지를 기본으로 막거나 안 띄우는
    // 클라이언트가 많아, 텍스트로 두면 어떤 클라이언트에서도 로고가 반드시 보인다.
    // (이미지 로고가 필요하면 logoUrl 에 절대주소를 넣으면 그 이미지로 바뀐다.)
    const SERIF = "Georgia,'Times New Roman','Nanum Myeongjo',serif";
    const isDalba = /d[’']?\s*alba/i.test(brand);
    const logoUrl = mediaSrc(d.logoUrl);   // cid(메일 인라인)·data·URL 모두 허용
    const wordmark = isDalba
      ? '<div style="font:400 44px/1 ' + SERIF + ";color:" + C.ink + ';letter-spacing:.5px;">d’Alba</div>' +
        '<div style="font:400 12px/1 ' + SERIF + ";color:" + C.ink + ';letter-spacing:.62em;padding:9px 0 0 .62em;">piedmont</div>'
      : '<div style="font:400 40px/1 ' + SERIF + ";color:" + C.ink + ';letter-spacing:.5px;">' + esc(brand) + "</div>";
    // 이미지가 막힌 클라이언트에서도 브랜드가 보이도록 alt 를 워드마크처럼 스타일링한다.
    // (이미지가 뜨면 이 글꼴 스타일은 이미지에 가려 안 보이고, 막히면 alt 가 이 스타일로 뜬다.)
    const logoBlock = '<div style="padding:0 0 18px;">' + (logoUrl
      ? '<img src="' + logoUrl + '" alt="' + esc(brand) +
        '" height="46" style="height:46px;max-width:70%;width:auto;border:0;outline:none;display:inline-block;' +
        "font:400 30px/46px " + SERIF + ";color:" + C.ink + ';" />'
      : wordmark) + "</div>";

    let body = "";

    // 인사 + 소개
    body += '<tr><td style="padding:0 0 18px;font:800 22px/1.35 ' + FONT + ";color:" + C.gold + ';">' +
      "Hi " + esc(creator) + "! 👋</td></tr>";

    // ── 리마인드(팔로업) — 첫 메일에 회신이 없을 때 짧게 다시 보낸다 ──
    // 껍데기(로고 헤더·서명·푸터)는 그대로 두고 본문만 짧은 팔로업으로 바꾼다.
    if (d.reminder) {
      body += para(has(d.reminderNote) ? nl2br(d.reminderNote) :
        "Just circling back on my note below about a <strong>" + esc(brand) + "</strong> collab — " +
        "we'd still love to work with you. Would this be something you're up for? " +
        "No pressure at all if the timing isn't right.");
      body += ctaBlock(d);
      // 서명으로 곧장 이어진다 (아래 공통 서명)
      return shell();
    }

    body += para(
      "We're <strong>" + esc(brand) + "</strong>" +
      (has(d.brandIntro) ? ", " + nl2br(d.brandIntro) : ", a Korean beauty brand working with creators on TikTok Shop.")
    );

    if (has(d.pitch)) body += para(nl2br(d.pitch));

    // 왜 당신인가 (개인화 한 줄 — 응답률의 핵심)
    if (has(d.whyYou)) {
      body += infoBox(
        '<div style="font:400 14.5px/1.65 ' + FONT + ";color:" + C.text + ';">' + nl2br(d.whyYou) + "</div>",
        { align: "left", pad: "18px 22px" }
      );
      body += '<tr><td style="height:6px;line-height:6px;">&nbsp;</td></tr>';
    }

    // 보상
    const rewards = rewardBlocks(d);
    if (rewards) body += sectionLabel("🎁", "Here's what you get") + rewards;

    // 캠페인 상세 · 제품
    body += detailRows(d);
    body += productBlock(d);
    body += videoBlock(d);

    // 다음 단계 · CTA
    body += stepsBlock(d);
    body += ctaBlock(d);

    // 담당자가 직접 만든 추가 안내 박스 (선물 폼·디스코드 초대 등)
    body += extrasBlock(d);

    if (has(d.notes)) {
      body += '<tr><td style="padding:24px 0 0;font:400 13px/1.6 ' + FONT + ";color:" + C.muted + ';">' +
        nl2br(d.notes) + "</td></tr>";
    }

    // 공통 마무리 — 서명 + 껍데기(헤더·푸터·MSO). 리마인드·일반 둘 다 여기로 모인다.
    return shell();

    function shell() {
    // 서명
    body += '<tr><td style="padding:30px 0 0;border-top:1px solid ' + C.line + ';"></td></tr>' +
      '<tr><td style="padding:18px 0 0;font:400 14px/1.65 ' + FONT + ";color:" + C.text + ';">' +
      "Looking forward to hearing from you!<br /><br />" +
      "<strong>" + esc(has(d.senderName) ? d.senderName : "") + "</strong>" +
      (has(d.senderTitle) ? '<br /><span style="color:' + C.muted + ';font-size:13px;">' + esc(d.senderTitle) + "</span>" : "") +
      (has(d.senderEmail) ? '<br /><a href="mailto:' + esc(d.senderEmail) + '" style="color:' + C.gold +
        ';text-decoration:none;font-size:13px;">' + esc(d.senderEmail) + "</a>" : "") +
      "</td></tr>";

    // 프리헤더 = 받은편지함 미리보기 첫 줄 (열람률에 직결)
    // 협업 조건이 "없음" 이면 금액 얘기를 빼고 담백하게 둔다.
    const preheader = has(d.preheader) ? d.preheader :
      (d.dealType === "none"
        ? "Collab with " + brand + " — details inside."
        : (has(d.amount) && (d.dealType !== "affiliate") ? money(d.currency, d.amount) + " paid collab" : "Paid collab") +
          " with " + brand + " — details inside.");

    return '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">' +
      '<html xmlns="http://www.w3.org/1999/xhtml"><head>' +
      '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />' +
      '<meta name="viewport" content="width=device-width,initial-scale=1" />' +
      '<meta name="x-apple-disable-message-reformatting" />' +
      "<title>" + esc(title) + "</title>" +
      "<style>" + MOBILE_CSS + "</style></head>" +
      '<body style="margin:0;padding:0;background:' + C.page +
      ';-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;word-break:break-word;">' +
      '<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px;">' +
      esc(preheader) + "</div>" +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + C.page + ';">' +
      '<tr><td align="center" class="gut" style="padding:28px 12px 44px;">' +
      // Outlook 데스크톱은 max-width 를 모른다 — 여기서만 600px 로 고정해 준다
      '<!--[if mso]><table role="presentation" width="' + WIDTH +
      '" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
      'style="width:100%;max-width:' + WIDTH + 'px;margin:0 auto;">' +

      // 헤더 (브랜드 노랑→크림 그라데이션 · 검정 로고)
      // background 를 단색 노랑으로 먼저 깔고 그 위에 그라데이션을 얹는다 —
      // Outlook 등 그라데이션을 무시하는 클라이언트는 단색 노랑으로 떨어져도 브랜드에 맞다.
      '<tr><td class="hd" style="background:' + C.heroFallback +
      ";background:linear-gradient(180deg," + C.heroTop + " 0%," + C.heroMid + " 46%," + C.heroBot + " 100%);" +
      'border-radius:14px;padding:36px 30px;text-align:center;">' +
      logoBlock +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;"><tr>' +
      // text-indent:.16em — 자간이 마지막 글자 뒤에도 공백을 남겨 글씨가 왼쪽으로 쏠리는 걸
      // 한 칸만큼 밀어 상쇄한다. 그래야 알약 안에서 정중앙에 온다.
      '<td style="border:1px solid rgba(23,23,23,.32);border-radius:999px;padding:7px 20px;font:700 11px/1.2 ' + FONT +
      ";letter-spacing:.16em;text-indent:.16em;color:" + C.inkSoft + ';">✉️ CAMPAIGN INVITATION</td>' +
      "</tr></table>" +
      '<div class="h1" style="font:800 25px/1.35 ' + FONT + ";color:" + C.ink + ';padding:16px 0 0;">' + esc(title) + "</div>" +
      "</td></tr>" +

      // 본문 카드
      '<tr><td style="height:14px;line-height:14px;">&nbsp;</td></tr>' +
      '<tr><td class="card" style="background:' + C.card + ';border-radius:14px;padding:34px 32px 36px;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' + body + "</table>" +
      "</td></tr>" +

      // 푸터
      '<tr><td style="padding:20px 10px 0;text-align:center;font:400 11.5px/1.6 ' + FONT + ";color:" + C.muted + ';">' +
      "You're receiving this because we'd love to work with you.<br />" +
      "Not interested? Just reply “no thanks” and we won't follow up." +
      "</td></tr>" +

      "</table>" +
      "<!--[if mso]></td></tr></table><![endif]-->" +
      "</td></tr></table></body></html>";
    }
  }

  // ─── 플레인 텍스트 대체본 (스팸 점수 · 접근성) ──────────────────
  function buildText(d) {
    d = resolve(d);
    const creator = has(d.creatorName) ? d.creatorName : (has(d.handle) ? "@" + String(d.handle).replace(/^@/, "") : "there");
    const brand = has(d.brand) ? d.brand : "d'Alba";
    const L = [];
    L.push("Hi " + creator + "!");
    L.push("");
    if (d.reminder) {
      L.push(has(d.reminderNote) ? d.reminderNote :
        "Just circling back on my note below about a " + brand + " collab — we'd still love to work with you. " +
        "Would this be something you're up for? No pressure at all if the timing isn't right.");
      if (safeUrl(d.applyUrl)) { L.push(""); L.push((has(d.applyLabel) ? d.applyLabel : "Count me in") + ": " + String(d.applyUrl).trim()); }
      L.push(""); L.push("Looking forward to hearing from you!");
      if (has(d.senderName)) L.push(d.senderName);
      if (has(d.senderTitle)) L.push(d.senderTitle);
      if (has(d.senderEmail)) L.push(d.senderEmail);
      return L.join("\n");
    }
    L.push("We're " + brand + (has(d.brandIntro) ? ", " + d.brandIntro : ", a Korean beauty brand working with creators on TikTok Shop."));
    if (has(d.pitch)) { L.push(""); L.push(d.pitch); }
    if (has(d.whyYou)) { L.push(""); L.push(d.whyYou); }

    const type = d.dealType || "paid";
    if ((type === "paid" || type === "both") && has(d.amount)) {
      L.push(""); L.push("HERE'S WHAT YOU GET");
      L.push("- Cash paid to you: " + money(d.currency, d.amount));
    }
    if ((type === "affiliate" || type === "both") && has(d.commission)) {
      if (!((type === "both") && has(d.amount))) { L.push(""); L.push("HERE'S WHAT YOU GET"); }
      L.push("- Affiliate commission: " + String(d.commission).replace(/[^0-9.]/g, "") + "% on every sale through your link");
    }
    if (has(d.deliverables)) { L.push(""); L.push("WHAT WE'D LOVE FROM YOU"); L.push(d.deliverables); }
    if (has(d.deadline)) { L.push(""); L.push("TIMELINE: " + d.deadline); }
    if (has(d.location)) { L.push("LOCATION: " + d.location); }
    if (has(d.product) || has(d.productDesc)) {
      L.push(""); L.push("ABOUT " + (has(d.brand) ? d.brand.toUpperCase() : "THE PRODUCT"));
      if (has(d.product)) L.push(d.product);
      if (has(d.productDesc)) L.push(d.productDesc);
      if (safeUrl(d.productUrl)) L.push(String(d.productUrl).trim());
    }
    const vids = normVideos(d.videos);
    if (vids.length) {
      L.push(""); L.push("VIDEOS THAT ARE ALREADY POPPING OFF");
      vids.forEach(function (v) { L.push("- " + (v.label ? v.label + " — " : "") + v.url.replace(/&amp;/g, "&")); });
    }
    const tSteps = (Array.isArray(d.steps) ? d.steps : DEFAULT_STEPS).filter(has);
    if (tSteps.length) {
      L.push(""); L.push("NEXT STEPS");
      L.push(has(d.stepsIntro) ? d.stepsIntro : DEFAULT_STEPS_INTRO);
      tSteps.forEach(function (s, i) { L.push((i + 1) + ". " + s); });
    }
    if (safeUrl(d.applyUrl)) { L.push(""); L.push((has(d.applyLabel) ? d.applyLabel : "Count me in") + ": " + String(d.applyUrl).trim()); }
    // 추가 안내 박스 (선물 폼·디스코드 등) — 텍스트 버전에도 담는다
    normExtras(d.extras).forEach(function (x) {
      L.push("");
      if (has(x.title)) L.push(String(x.title).toUpperCase());
      if (has(x.body)) L.push(x.body);
      if (safeUrl(x.buttonUrl)) L.push((has(x.buttonLabel) ? x.buttonLabel : "Learn more") + ": " + String(x.buttonUrl).trim());
    });
    if (has(d.notes)) { L.push(""); L.push(d.notes); }
    L.push(""); L.push("Looking forward to hearing from you!");
    if (has(d.senderName)) L.push(d.senderName);
    if (has(d.senderTitle)) L.push(d.senderTitle);
    if (has(d.senderEmail)) L.push(d.senderEmail);
    return L.join("\n");
  }

  // ─── 개인화 변수 ───────────────────────────────────────────────
  // 제목뿐 아니라 본문 문구에서도 {{name}} {{handle}} {{amount}} … 를 쓸 수 있다.
  // (대량 발송에서 한 문장만 바꿔 개인화할 때 핵심)
  const FILLABLE = [
    "subject", "campaignTitle", "brandIntro", "pitch", "whyYou",
    "deliverables", "deadline", "location", "productDesc", "notes",
    "paymentNote", "commissionNote", "applyLabel", "preheader", "videosNote", "stepsIntro", "reminderNote"
  ];

  function varsOf(d) {
    return {
      name: has(d.creatorName) ? d.creatorName : String(d.handle || "").replace(/^@/, ""),
      handle: has(d.handle) ? "@" + String(d.handle).replace(/^@/, "") : "",
      brand: has(d.brand) ? d.brand : "d'Alba",
      campaign: has(d.campaignTitle) ? d.campaignTitle : "Creator Collab",
      product: d.product || "",
      amount: money(d.currency, d.amount),
      commission: has(d.commission) ? String(d.commission).replace(/[^0-9.]/g, "") + "%" : "",
      sender: d.senderName || ""
    };
  }

  // 치환을 미리 끝낸 사본을 만든다 (원본은 건드리지 않음)
  function resolve(d) {
    const src = d || {};
    const vars = varsOf(src);
    const out = Object.assign({}, src);
    FILLABLE.forEach(function (k) { if (has(out[k])) out[k] = fill(out[k], vars); });
    // steps 는 문자열 배열이라 따로 처리한다
    if (Array.isArray(out.steps)) out.steps = out.steps.map(function (s) { return fill(s, vars); });
    // extras 의 제목·내용·버튼이름도 {{name}} 등 치환을 받는다 (원본은 안 건드림)
    if (Array.isArray(out.extras)) out.extras = out.extras.map(function (x) {
      return Object.assign({}, x, {
        title: fill(x && x.title, vars),
        body: fill(x && x.body, vars),
        buttonLabel: fill(x && x.buttonLabel, vars)
      });
    });
    return out;
  }

  // ─── 제목 ──────────────────────────────────────────────────────
  const DEFAULT_SUBJECT = "[{{brand}}] 💛 Paid Collab X {{name}} — {{campaign}}";

  function buildSubject(d) {
    const raw = has(d.subject) ? d.subject : DEFAULT_SUBJECT;
    const s = fill(raw, varsOf(d)).replace(/\s{2,}/g, " ").replace(/\s*—\s*$/, "").trim();
    // 리마인드는 같은 스레드로 이어지도록 원 제목에 Re: 를 붙인다 (이미 있으면 그대로)
    if (d.reminder) return /^re:/i.test(s) ? s : "Re: " + s;
    return s;
  }

  // ─── 입력 검증 (서버·클라이언트 공통) ───────────────────────────
  function validate(d) {
    const errs = [];
    if (!has(d.to)) errs.push("크리에이터 이메일이 없습니다");
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(d.to).trim())) errs.push("이메일 형식이 올바르지 않습니다: " + d.to);
    if (!has(d.campaignTitle)) errs.push("캠페인 제목이 없습니다");
    // 협업 조건(유상/어필리에이트)과 금액·커미션은 **선택**이다. 비워 두면 메일의 금액 박스가
    // 빠질 뿐 발송은 막지 않는다 — 조건을 나중에 협의하는 아웃리치도 있기 때문.
    return errs;
  }

  function build(d) {
    return { subject: buildSubject(d), html: buildHtml(d), text: buildText(d) };
  }

  return {
    build: build,
    buildHtml: buildHtml,
    buildText: buildText,
    buildSubject: buildSubject,
    validate: validate,
    money: money,
    parseList: parseList,
    DEFAULT_SUBJECT: DEFAULT_SUBJECT,
    DEFAULT_STEPS_INTRO: DEFAULT_STEPS_INTRO,
    DEFAULT_STEPS: DEFAULT_STEPS,
    COLORS: C
  };
});
