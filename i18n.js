/*!
 * 화면 번역 — 한국어 · English · Tiếng Việt
 *
 * ─── 왜 화면을 그린 뒤에 번역하나 ────────────────────────────────
 * 화면 문구가 HTML 과 JS 문자열에 400줄 가까이 흩어져 있다. 하나하나 t("키") 로
 * 바꾸면 손이 많이 갈 뿐 아니라, **앞으로 문구를 추가할 때마다 빠뜨리기 쉽다.**
 * 그래서 화면에 그려진 뒤 텍스트 노드를 훑어 번역한다 — 렌더 코드를 건드리지 않고,
 * 새로 생기는 문구도 MutationObserver 가 자동으로 잡는다.
 *
 * 사전에 없는 문구는 **한국어 그대로 남는다.** 번역이 빠져도 화면이 깨지지 않고,
 * 무엇이 아직 안 됐는지 눈에 보인다 (조용히 빈 칸이 되는 것보다 낫다).
 *
 * ─── 숫자가 섞인 문구 ────────────────────────────────────────────
 * "3명 인식" 같은 문구는 숫자만 다르고 형태가 같다. 숫자를 {n} 으로 바꿔 한 번만
 * 등록하면 되도록, 정확히 일치하는 항목이 없으면 숫자를 자리표시자로 바꿔 다시 찾는다.
 *
 * ─── 한계 ────────────────────────────────────────────────────────
 * 한 문장이 <b> 같은 태그로 쪼개져 있으면 조각 단위로 번역된다. 한국어는 조사가
 * 뒤에 붙는 언어라 조각을 그대로 옮기면 어순이 어색해질 수 있어, 그런 조각은
 * 영어·베트남어에서 자연스럽게 읽히도록 따로 손봤다.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.I18N = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const LANGS = [
    { code: "ko", label: "한국어" },
    { code: "en", label: "English" },
    { code: "vi", label: "Tiếng Việt" }
  ];

  // 한국어 원문을 열쇠로 쓴다 — 키를 새로 짓지 않아도 되고, 사전에 없으면 원문이 그대로 남는다
  const DICT = {
    en: {
      // ── 로그인 ──
      "🔒 크리에이터 아웃리치 발송": "🔒 Creator Outreach",
      "🔐 관리자 로그인": "🔐 Admin Sign-in",
      "아이디": "ID",
      "비밀번호": "Password",
      "아이디와 비밀번호를 입력하세요": "Enter your ID and password",
      "비밀번호를 입력하세요": "Enter the password",
      "아이디 또는 비밀번호가 올바르지 않습니다": "Incorrect ID or password",
      "들어가기": "Sign in",
      "로그인": "Sign in",
      "로그아웃": "Sign out",
      "로그인 필요": "Sign-in required",
      "로그인이 필요합니다.": "Please sign in.",
      "다시 로그인해 주세요.": "Please sign in again.",

      // ── 헤더 · 공통 ──
      "📨 크리에이터 아웃리치 발송": "📨 Creator Outreach",
      "크리에이터 아웃리치 발송": "Creator Outreach",
      "핸들 · 금액 · 제품만 넣으면 브랜드 메일이 완성돼 네이버웍스로 바로 나갑니다":
        "Enter handle, amount and product — the branded email is built and sent via Naver Works.",
      "📊 아웃리치 현황": "📊 Outreach Dashboard",
      "아웃리치 현황 · 관리자": "Outreach Dashboard · Admin",
      "✉️ 발송 화면": "✉️ Send",
      "✉️ 내 발신 계정": "✉️ My sender account",
      "관리자": "Admin",
      "저장": "Save",
      "취소": "Cancel",
      "닫기": "Close",
      "지우기": "Clear",
      "새로고침": "Refresh",
      "선택": "optional",

      // ── 발송 폼 ──
      "1명에게 보내기": "Send to one",
      "명단으로 여러 명": "Send to a list",
      "받는 크리에이터": "Recipient",
      "이메일": "Email",
      "이름": "Name",
      "핸들": "Handle",
      "틱톡 핸들": "TikTok handle",
      "개인화 한 줄": "Personal note",
      "개인화": "Personal note",
      "브랜드": "Brand",
      "브랜드 한 줄 소개": "Brand intro",
      "캠페인": "Campaign",
      "캠페인 제목": "Campaign title",
      "메일 제목": "Subject",
      "제목": "Subject",
      "제안 문단": "Pitch",
      "협업 조건": "Deal",
      "유상 협업": "Paid",
      "어필리에이트": "Affiliate",
      "유상 + 어필리에이트": "Paid + Affiliate",
      "금액": "Amount",
      "통화": "Currency",
      "커미션": "Commission",
      "커미션 %": "Commission %",
      "커미션 부연": "Commission note",
      "지급 조건": "Payment terms",
      "요청 산출물": "Deliverables",
      "일정 / 마감": "Timeline",
      "장소": "Location",
      "제품": "Product",
      "제품명": "Product name",
      "제품 설명": "Product description",
      "제품 이미지 URL": "Product image URL",
      "제품 링크": "Product link",
      "이 제품 바이럴 영상": "Viral videos for this product",
      "영상 섹션 문구": "Video section note",
      "안내 문장": "Intro line",
      "버튼 · 맺음말": "Button · Closing",
      "맺음말": "Closing",
      "직함": "Title",
      "발송": "Send",
      "미리보기 갱신": "Refresh preview",
      "받는 사람": "To",
      "받는 사람이 아직 없습니다": "No recipients yet",
      "이미 보낸 사람에게도": "Send even to people already contacted —",
      "강제 발송": "force send",
      "네, 보냅니다": "Yes, send",
      "📨 발송할까요?": "📨 Send now?",
      "보낸 메일은 되돌릴 수 없습니다. 발신자·수신자·금액을 다시 확인하세요.":
        "Sent mail cannot be undone. Double-check sender, recipients and amount.",

      // ── 도움말 ──
      "— 메일 첫 줄 \"Hi ○○!\"": "— first line of the email, \"Hi ○○!\"",
      "— 왜 이 사람인지. 응답률에 가장 큰 영향": "— why them. The biggest driver of reply rate",
      "— \"We're d'Alba, ___\" 뒤에 붙습니다": "— follows \"We're d'Alba, ___\"",
      "— {{name}} {{brand}} {{campaign}} {{amount}} {{commission}} 사용 가능":
        "— {{name}} {{brand}} {{campaign}} {{amount}} {{commission}} available",
      "— 금액 박스 아래 문구": "— note under the amount box",
      "— 메일에 그대로 표시됩니다 (https 이미지 직링크)": "— shown in the email (direct https image link)",
      "— 비우면 버튼이 빠짐": "— leave empty to drop the button",
      "— 메일 서명과 발신자 이름에 표시": "— shown in the signature and sender name",
      "— 오프라인 촬영일 때만": "— only for in-person shoots",
      "— 아래 공통 조건보다 우선": "— overrides the shared settings below",
      "아래 공통 조건보다 우선": "overrides the shared settings below",
      "이미 잘 나가고 있다는 증거가 수락률을 가장 크게 올립니다. 링크만 넣어도 되고, 라벨(조회수 등)을 같이 넣으면 더 좋아요.":
        "Proof it is already performing lifts acceptance the most. A link alone works; adding a label (view count) is better.",
      "인하우스 팀이 전달한 영상을 넣으세요. 링크만 넣어도 되고, 라벨(조회수 등)을 같이 넣으면 더 좋아요.":
        "Add the videos the in-house team sent you. A link alone works; adding a label (view count) is better.",
      "⚠️ 영상은 d'Alba 인하우스 팀이 선정해 전달합니다.":
        "⚠️ Videos are selected and provided by the d'Alba in-house team.",
      "전달받은 영상만 넣고, 임의로 아무거나 고르지 마세요.":
        "Only use the videos you were given — do not pick arbitrary ones.",
      "번호 칸을 비우면 그 줄은 메일에서 빠집니다. 필요하면 단가·배송지 같은 항목을 추가하세요.":
        "Leave a numbered field empty to drop that line. Add items like rate or shipping address if needed.",

      // ── 대량 발송 ──
      "명단 붙여넣기": "Paste your list",
      "구글시트·엑셀에서": "From Google Sheets or Excel,",
      "으로 복사해 그대로 붙여넣으세요.": "copy and paste directly.",
      "헤더 포함": "with headers",
      "인식하는 열:": "Recognized columns:",
      "(필수) · name · handle · amount · commission · whyYou": "(required) · name · handle · amount · commission · whyYou",
      "amount/commission 을 넣은 행은 그 값이": "Rows with amount/commission use those values —",
      "행 제외": "rows excluded",
      "이메일 형식 오류": "invalid email format",
      "이메일 없음": "no email",
      "중복 — 건너뜀": "duplicate — skipped",
      "대상": "Target",
      "수신자": "Recipient",
      "사유": "Reason",

      // ── 발신 계정 ──
      "네이버웍스 이메일": "Naver Works email",
      "외부 앱 비밀번호": "App password",
      "네이버웍스에서 발급한 앱 비밀번호": "App password issued by Naver Works",
      "네이버웍스 로그인 비밀번호로는 발송이 안 돼요.": "Your Naver Works login password will not work.",
      "앱 비밀번호가 필요합니다.": "An app password is required.",
      "에서 발급하세요.": "to issue one.",
      "설정 > 보안 > 외부 앱 비밀번호": "Settings > Security > App password",
      "메뉴가 안 보이면 조직 관리자가 관리자센터에서": "If you cannot see the menu, an org admin must enable",
      "을 먼저 켜야 합니다.": "first.",
      "이 브라우저에만 저장돼요. 여기 등록한 주소 그대로 메일이 나가고, 답장도 이 주소로 옵니다.":
        "Stored in this browser only. Mail goes out from this address and replies come back here.",
      "로그인 계정으로 발송됩니다": "Sent from your signed-in account",

      // ── 상품 선택기 ──
      "🛍 TikTok Shop에서 선택": "🛍 Pick from TikTok Shop",
      "🛍 상품 선택": "🛍 Pick a product",
      "상품명 또는 상품 ID 검색…": "Search by product name or ID…",
      "판매중이 아닌 상품도 보기": "Include inactive products",
      "품절": "Out of stock",
      "이미지 없음": "No image",
      "재고": "Stock",
      "불러오는 중…": "Loading…",
      "상품이 없습니다.": "No products.",
      "검색 결과가 없습니다.": "No results.",
      "그 ID 의 상품을 찾지 못했습니다.": "No product found with that ID.",
      "제품명 · 이미지 · 제품 링크": "name · image · link",
      "선택하면": "Picking one fills",
      "가 자동으로 채워집니다.": "automatically.",
      "(판매중)": "(active)",

      // ── 미리보기 ──
      "🖥 PC": "🖥 Desktop",
      "📱 모바일": "📱 Mobile",
      "아이폰 기준": "iPhone width",
      "미리보기": "Preview",

      // ── 관리자 화면 ──
      "담당자별": "By staff",
      "📈 일별": "📈 Daily",
      "발송 이력": "Sent history",
      "⏸ 중복 시도": "⏸ Blocked attempts",
      "담당자": "Staff",
      "담당자 전체": "All staff",
      "내 메일함": "My mailbox",
      "전체 (2026-07-01~)": "All (from 2026-07-01)",
      "최근 7일": "Last 7 days",
      "최근 14일": "Last 14 days",
      "최근 30일": "Last 30 days",
      "이메일 · 이름 · 핸들 · 캠페인 검색…": "Search email · name · handle · campaign…",
      "기간 내 발송": "Sent in range",
      "접촉한 크리에이터": "Creators reached",
      "회신한 크리에이터": "Creators who replied",
      "회신": "Replies",
      "회신율": "Reply rate",
      "회신(명)": "Replies (people)",
      "중복으로 막힌 시도": "Blocked as duplicate",
      "중복으로 막힘": "Blocked as duplicate",
      "중복 시도": "Blocked attempts",
      "발송한 날": "Days with sends",
      "가장 많은 날": "Busiest day",
      "마지막 발송": "Last send",
      "보낸 시각": "Sent at",
      "시도 시각": "Attempted at",
      "시도한 담당자": "Attempted by",
      "원래 보낸 사람": "Originally sent by",
      "원래 발송": "Original send",
      "이전 발송": "Previous send",
      "날짜": "Date",
      "강제": "forced",
      "일": "d",
      "막대에 마우스를 올리면 그날 내역이 보입니다": "Hover a bar to see that day's detail",
      "🔄 메일함에서 동기화": "🔄 Sync from mailbox",
      "마지막 자동 동기화": "Last auto-sync",
      "· 매일 07:00(KST) 자동 실행": "· runs daily at 07:00 KST",
      "(전원을 다 못 돌아 다음 실행이 이어받습니다)": "(did not finish everyone; the next run continues)",
      "이미 다른 담당자가 보낸 크리에이터라서": "Creators another staff member already contacted, so these were",
      "발송되지 않은": "not sent",
      "시도입니다. 같은 사람이 자주 겹친다면 명단 배분을 조정할 신호입니다.":
        "attempts. Frequent overlap on the same person is a signal to rebalance the lists.",
      "기록이 많아 최근 것부터 일부만 불러왔습니다. 기간이나 검색어로 좁혀 보세요.":
        "Too many records — only the most recent are shown. Narrow by period or search.",
      "해당하는 기록이 없습니다.": "No matching records.",
      "중복 시도가 없습니다. 👍": "No duplicate attempts. 👍",
      "관리자만 볼 수 있습니다": "Admins only",

      // ── 결과 · 상태 ──
      "발송 완료 · ⏸": "sent · ⏸",
      "은 이미 발송돼 보류했습니다.": "were held as already contacted.",
      "은 보류됩니다 (나머지만 발송).": "will be held (the rest are sent).",
      "⏸ 이미 보낸": "⏸ Already contacted:",
      "⚠️ 이미 보낸": "⚠️ Already contacted:",
      "에게도": "will also receive this —",
      "⚠️ 이미 보낸 사람에게도 강제 발송합니다.": "⚠️ Force-sending even to people already contacted.",
      "보류된 수신자 — 그래도 보내려면 [강제 발송] 을 켜고 다시 누르세요.":
        "Held recipients — turn on [force send] and press again to send anyway.",
      "에서": "→",
      "에게 보냅니다.": "recipient(s).",
      "⏸ 보류": "⏸ Held",
      "90일 안에 이미 보낸 주소는 자동 보류됩니다": "Addresses contacted within 90 days are held automatically",
      "크리에이터 이메일이 없습니다": "Creator email is missing",
      "캠페인 제목이 없습니다": "Campaign title is missing",
      "유상 협업인데 금액이 없습니다": "Paid collab with no amount",
      "어필리에이트인데 커미션율이 없습니다": "Affiliate with no commission rate",
      "합니다.": ".",
      // ── 수집기가 잡아낸 나머지 조각 ──
      "— 선택": "— optional",
      "· 관리자": "· Admin",
      // ── 관리자 화면의 긴 안내문 (JS 로 만든다) ──
      "자동 동기화(매일 07:00 KST)가 아직 돈 기록이 없습니다. 눌러서":
        "Auto-sync (daily 07:00 KST) has not run yet. Press to pull in sends and replies from",
      "2026-07-01 이후": "2026-07-01 onward",
      "발송·회신을 지금 바로 가져오세요.": "right now.",
      "이후": "onward",
      "담당자 메일함을 훑어": "Scans staff mailboxes and fills in sends and replies from",
      "이후 발송·회신을 채웁니다. 누르기 전까지 갱신되지 않습니다.": "onward. Nothing updates until you press it.",
      "마지막 자동 동기화": "Last auto-sync",
      "아직 기록이 없습니다.": "No records yet.",
      "자동 동기화는": "Auto-sync runs daily at",
      "에 돕니다. 아직 한 번도 안 돌았다면, 담당자별 탭의": ". If it has never run, use",
      "로": "in the By-staff tab to pull",
      "이후 발송·회신을 지금 바로 가져올 수 있습니다.": "onward right now.",
      "담당자 수에 따라 몇 분 걸립니다. 이 도구로 새로 보내는 메일은 기다리지 않아도 바로 잡힙니다.":
        "Takes a few minutes depending on headcount. Mail newly sent with this tool is recorded immediately.",
      "메일함을 읽는 중…": "reading mailbox…",
      "(인원에 따라 몇 분 걸릴 수 있습니다)": "(may take a few minutes depending on headcount)",
      "동기화 완료": "Sync complete",
      "동기화 끝 (일부 실패)": "Sync finished (some failed)",
      "· 새 발송": "· new sends",
      "· 새 회신": "· new replies",
      "(2026-07-01 이후, 이미 있던 건 건너뜀)": "(from 2026-07-01; existing records skipped)",
      "실패:": "Failed:",
      "등록된 담당자가 없습니다 (NW_ACCOUNTS).": "No staff registered (NW_ACCOUNTS).",
      "시간 초과 — 메일이 많아 한 번에 못 끝냈습니다. 다시 누르면 이어서 처리됩니다.":
        "Timed out — too much mail to finish at once. Press again to continue.",
      "서버 오류 (HTTP": "Server error (HTTP",
      "발송 이력 저장소가 아직 연결되지 않았습니다.": "The send-history store is not connected yet.",
      "이력이 쌓일 곳이 없어서 담당자별·크리에이터별·중복 시도를 보여줄 수 없습니다. 중복 발송 차단도 함께 꺼져 있는 상태입니다.":
        "With nowhere to store history, per-staff and duplicate views cannot be shown. Duplicate blocking is off too.",
      "붙이는 법 (한 번만)": "How to connect (once)",
      "1. Vercel → 이 프로젝트 →": "1. Vercel → this project →",
      "탭 →": "tab →",
      "2.": "2.",
      "선택 → 프로젝트에": "→ Connect to the project",
      "3.": "3.",
      "→ 맨 위 배포의": "→ on the latest deployment,",
      "→": "→",
      "연결하면 KV_REST_API_URL / KV_REST_API_TOKEN 이 자동으로 들어갑니다. 무료 티어로 충분합니다.":
        "Connecting injects KV_REST_API_URL / KV_REST_API_TOKEN automatically. The free tier is enough.",
      "붙이고 나면 담당자별 화면의": "Once connected, use",
      "로 2026-07-01 이후 발송·회신을 메일함에서 채울 수 있습니다.":
        "on the By-staff screen to fill sends and replies from 2026-07-01 onward.",
      "먼저 위에서 제품을 고르세요.": "Pick a product above first.",
      "이 제품의 영상이 시트에 없습니다.": "No videos for this product in the sheet.",
      "영상 칸 3개가 다 찼습니다. 하나를 비우고 다시 고르세요.": "All 3 video slots are full. Clear one and pick again.",
      "📈 영상 불러오기": "📈 Load videos",
      "· 매출순": "· by sales",
      "넣음": "added",
      "명 인식 ·": "recognized ·",
      "명 인식": "recognized",
      "네이버웍스 →": "Naver Works →",
      "IMAP/POP3·SMTP 사용": "IMAP/POP3 · SMTP access",
      "CTA 버튼 링크": "CTA button link",
      "CTA 버튼 문구": "CTA button label",
      "Next steps — 답장에 뭘 담아 달라고 할지": "Next steps — what to ask for in their reply",
      "건": "",
      "관리자": "Admin"
    },

    vi: {
      // ── Đăng nhập ──
      "🔒 크리에이터 아웃리치 발송": "🔒 Gửi thư mời Creator",
      "🔐 관리자 로그인": "🔐 Đăng nhập quản trị",
      "아이디": "Tên đăng nhập",
      "비밀번호": "Mật khẩu",
      "아이디와 비밀번호를 입력하세요": "Nhập tên đăng nhập và mật khẩu",
      "비밀번호를 입력하세요": "Nhập mật khẩu",
      "아이디 또는 비밀번호가 올바르지 않습니다": "Tên đăng nhập hoặc mật khẩu không đúng",
      "들어가기": "Đăng nhập",
      "로그인": "Đăng nhập",
      "로그아웃": "Đăng xuất",
      "로그인 필요": "Cần đăng nhập",
      "로그인이 필요합니다.": "Vui lòng đăng nhập.",
      "다시 로그인해 주세요.": "Vui lòng đăng nhập lại.",

      // ── Chung ──
      "📨 크리에이터 아웃리치 발송": "📨 Gửi thư mời Creator",
      "크리에이터 아웃리치 발송": "Gửi thư mời Creator",
      "핸들 · 금액 · 제품만 넣으면 브랜드 메일이 완성돼 네이버웍스로 바로 나갑니다":
        "Chỉ cần nhập handle, số tiền và sản phẩm — email thương hiệu sẽ được tạo và gửi qua Naver Works.",
      "📊 아웃리치 현황": "📊 Bảng theo dõi",
      "아웃리치 현황 · 관리자": "Bảng theo dõi · Quản trị",
      "✉️ 발송 화면": "✉️ Gửi thư",
      "✉️ 내 발신 계정": "✉️ Tài khoản gửi của tôi",
      "관리자": "Quản trị",
      "저장": "Lưu",
      "취소": "Hủy",
      "닫기": "Đóng",
      "지우기": "Xóa",
      "새로고침": "Tải lại",
      "선택": "tùy chọn",

      // ── Biểu mẫu ──
      "1명에게 보내기": "Gửi cho một người",
      "명단으로 여러 명": "Gửi theo danh sách",
      "받는 크리에이터": "Người nhận",
      "이메일": "Email",
      "이름": "Tên",
      "핸들": "Handle",
      "틱톡 핸들": "Handle TikTok",
      "개인화 한 줄": "Ghi chú cá nhân",
      "개인화": "Ghi chú cá nhân",
      "브랜드": "Thương hiệu",
      "브랜드 한 줄 소개": "Giới thiệu thương hiệu",
      "캠페인": "Chiến dịch",
      "캠페인 제목": "Tên chiến dịch",
      "메일 제목": "Tiêu đề email",
      "제목": "Tiêu đề",
      "제안 문단": "Nội dung đề xuất",
      "협업 조건": "Hình thức hợp tác",
      "유상 협업": "Trả phí",
      "어필리에이트": "Affiliate",
      "유상 + 어필리에이트": "Trả phí + Affiliate",
      "금액": "Số tiền",
      "통화": "Tiền tệ",
      "커미션": "Hoa hồng",
      "커미션 %": "Hoa hồng %",
      "커미션 부연": "Ghi chú hoa hồng",
      "지급 조건": "Điều kiện thanh toán",
      "요청 산출물": "Nội dung yêu cầu",
      "일정 / 마감": "Thời hạn",
      "장소": "Địa điểm",
      "제품": "Sản phẩm",
      "제품명": "Tên sản phẩm",
      "제품 설명": "Mô tả sản phẩm",
      "제품 이미지 URL": "URL ảnh sản phẩm",
      "제품 링크": "Link sản phẩm",
      "이 제품 바이럴 영상": "Video viral của sản phẩm",
      "영상 섹션 문구": "Ghi chú mục video",
      "안내 문장": "Câu dẫn",
      "버튼 · 맺음말": "Nút · Lời kết",
      "맺음말": "Lời kết",
      "직함": "Chức danh",
      "발송": "Gửi",
      "미리보기 갱신": "Cập nhật xem trước",
      "받는 사람": "Đến",
      "받는 사람이 아직 없습니다": "Chưa có người nhận",
      "이미 보낸 사람에게도": "Gửi cả cho người đã liên hệ —",
      "강제 발송": "gửi cưỡng chế",
      "네, 보냅니다": "Vâng, gửi",
      "📨 발송할까요?": "📨 Gửi ngay?",
      "보낸 메일은 되돌릴 수 없습니다. 발신자·수신자·금액을 다시 확인하세요.":
        "Email đã gửi không thể thu hồi. Hãy kiểm tra lại người gửi, người nhận và số tiền.",

      // ── Trợ giúp ──
      "— 메일 첫 줄 \"Hi ○○!\"": "— dòng đầu email, \"Hi ○○!\"",
      "— 왜 이 사람인지. 응답률에 가장 큰 영향": "— lý do chọn họ. Ảnh hưởng lớn nhất đến tỷ lệ phản hồi",
      "— \"We're d'Alba, ___\" 뒤에 붙습니다": "— nối sau \"We're d'Alba, ___\"",
      "— {{name}} {{brand}} {{campaign}} {{amount}} {{commission}} 사용 가능":
        "— có thể dùng {{name}} {{brand}} {{campaign}} {{amount}} {{commission}}",
      "— 금액 박스 아래 문구": "— ghi chú dưới ô số tiền",
      "— 메일에 그대로 표시됩니다 (https 이미지 직링크)": "— hiển thị trong email (link ảnh https trực tiếp)",
      "— 비우면 버튼이 빠짐": "— để trống thì bỏ nút",
      "— 메일 서명과 발신자 이름에 표시": "— hiển thị ở chữ ký và tên người gửi",
      "— 오프라인 촬영일 때만": "— chỉ khi quay trực tiếp",
      "— 아래 공통 조건보다 우선": "— ưu tiên hơn cài đặt chung bên dưới",
      "아래 공통 조건보다 우선": "ưu tiên hơn cài đặt chung bên dưới",
      "이미 잘 나가고 있다는 증거가 수락률을 가장 크게 올립니다. 링크만 넣어도 되고, 라벨(조회수 등)을 같이 넣으면 더 좋아요.":
        "Bằng chứng sản phẩm đang bán tốt giúp tăng tỷ lệ đồng ý nhiều nhất. Chỉ cần link là được, thêm nhãn (lượt xem) thì tốt hơn.",
      "인하우스 팀이 전달한 영상을 넣으세요. 링크만 넣어도 되고, 라벨(조회수 등)을 같이 넣으면 더 좋아요.":
        "Hãy dùng video do nhóm nội bộ gửi cho bạn. Chỉ cần link là được, thêm nhãn (lượt xem) thì tốt hơn.",
      "⚠️ 영상은 d'Alba 인하우스 팀이 선정해 전달합니다.":
        "⚠️ Video do nhóm nội bộ d'Alba chọn và cung cấp.",
      "전달받은 영상만 넣고, 임의로 아무거나 고르지 마세요.":
        "Chỉ dùng video được cung cấp — đừng tự ý chọn video bất kỳ.",
      "번호 칸을 비우면 그 줄은 메일에서 빠집니다. 필요하면 단가·배송지 같은 항목을 추가하세요.":
        "Để trống ô số thì dòng đó bị bỏ khỏi email. Có thể thêm mục như đơn giá hay địa chỉ giao hàng.",

      // ── Danh sách ──
      "명단 붙여넣기": "Dán danh sách",
      "구글시트·엑셀에서": "Từ Google Sheets hoặc Excel,",
      "으로 복사해 그대로 붙여넣으세요.": "sao chép và dán trực tiếp.",
      "헤더 포함": "kèm tiêu đề cột",
      "인식하는 열:": "Cột được nhận diện:",
      "(필수) · name · handle · amount · commission · whyYou": "(bắt buộc) · name · handle · amount · commission · whyYou",
      "amount/commission 을 넣은 행은 그 값이": "Dòng có amount/commission sẽ dùng giá trị đó —",
      "행 제외": "dòng bị loại",
      "이메일 형식 오류": "sai định dạng email",
      "이메일 없음": "thiếu email",
      "중복 — 건너뜀": "trùng — bỏ qua",
      "대상": "Đối tượng",
      "수신자": "Người nhận",
      "사유": "Lý do",

      // ── Tài khoản gửi ──
      "네이버웍스 이메일": "Email Naver Works",
      "외부 앱 비밀번호": "Mật khẩu ứng dụng",
      "네이버웍스에서 발급한 앱 비밀번호": "Mật khẩu ứng dụng do Naver Works cấp",
      "네이버웍스 로그인 비밀번호로는 발송이 안 돼요.": "Mật khẩu đăng nhập Naver Works sẽ không dùng được.",
      "앱 비밀번호가 필요합니다.": "Cần mật khẩu ứng dụng.",
      "에서 발급하세요.": "để tạo.",
      "설정 > 보안 > 외부 앱 비밀번호": "Cài đặt > Bảo mật > Mật khẩu ứng dụng",
      "메뉴가 안 보이면 조직 관리자가 관리자센터에서": "Nếu không thấy menu, quản trị viên tổ chức phải bật",
      "을 먼저 켜야 합니다.": "trước.",
      "이 브라우저에만 저장돼요. 여기 등록한 주소 그대로 메일이 나가고, 답장도 이 주소로 옵니다.":
        "Chỉ lưu trong trình duyệt này. Email gửi từ địa chỉ này và phản hồi cũng về đây.",
      "로그인 계정으로 발송됩니다": "Gửi từ tài khoản đã đăng nhập",

      // ── Chọn sản phẩm ──
      "🛍 TikTok Shop에서 선택": "🛍 Chọn từ TikTok Shop",
      "🛍 상품 선택": "🛍 Chọn sản phẩm",
      "상품명 또는 상품 ID 검색…": "Tìm theo tên hoặc ID sản phẩm…",
      "판매중이 아닌 상품도 보기": "Hiện cả sản phẩm ngừng bán",
      "품절": "Hết hàng",
      "이미지 없음": "Không có ảnh",
      "재고": "Tồn kho",
      "불러오는 중…": "Đang tải…",
      "상품이 없습니다.": "Không có sản phẩm.",
      "검색 결과가 없습니다.": "Không có kết quả.",
      "그 ID 의 상품을 찾지 못했습니다.": "Không tìm thấy sản phẩm với ID đó.",
      "제품명 · 이미지 · 제품 링크": "tên · ảnh · link",
      "선택하면": "Chọn một sản phẩm sẽ tự điền",
      "가 자동으로 채워집니다.": ".",
      "(판매중)": "(đang bán)",

      // ── Xem trước ──
      "🖥 PC": "🖥 Máy tính",
      "📱 모바일": "📱 Điện thoại",
      "아이폰 기준": "theo iPhone",
      "미리보기": "Xem trước",

      // ── Bảng quản trị ──
      "담당자별": "Theo nhân viên",
      "📈 일별": "📈 Theo ngày",
      "발송 이력": "Lịch sử gửi",
      "⏸ 중복 시도": "⏸ Bị chặn trùng",
      "담당자": "Nhân viên",
      "담당자 전체": "Tất cả nhân viên",
      "내 메일함": "Hộp thư của tôi",
      "전체 (2026-07-01~)": "Tất cả (từ 2026-07-01)",
      "최근 7일": "7 ngày gần đây",
      "최근 14일": "14 ngày gần đây",
      "최근 30일": "30 ngày gần đây",
      "이메일 · 이름 · 핸들 · 캠페인 검색…": "Tìm email · tên · handle · chiến dịch…",
      "기간 내 발송": "Đã gửi trong kỳ",
      "접촉한 크리에이터": "Creator đã liên hệ",
      "회신한 크리에이터": "Creator đã phản hồi",
      "회신": "Phản hồi",
      "회신율": "Tỷ lệ phản hồi",
      "회신(명)": "Phản hồi (người)",
      "중복으로 막힌 시도": "Bị chặn do trùng",
      "중복으로 막힘": "Bị chặn do trùng",
      "중복 시도": "Lượt bị chặn",
      "발송한 날": "Số ngày có gửi",
      "가장 많은 날": "Ngày nhiều nhất",
      "마지막 발송": "Lần gửi cuối",
      "보낸 시각": "Thời điểm gửi",
      "시도 시각": "Thời điểm thử",
      "시도한 담당자": "Người thử gửi",
      "원래 보낸 사람": "Người đã gửi trước",
      "원래 발송": "Lần gửi gốc",
      "이전 발송": "Lần gửi trước",
      "날짜": "Ngày",
      "강제": "cưỡng chế",
      "일": "ngày",
      "막대에 마우스를 올리면 그날 내역이 보입니다": "Di chuột lên cột để xem chi tiết ngày đó",
      "🔄 메일함에서 동기화": "🔄 Đồng bộ từ hộp thư",
      "마지막 자동 동기화": "Đồng bộ tự động lần cuối",
      "· 매일 07:00(KST) 자동 실행": "· chạy tự động 07:00 (KST) mỗi ngày",
      "(전원을 다 못 돌아 다음 실행이 이어받습니다)": "(chưa xong hết; lần chạy sau sẽ tiếp tục)",
      "이미 다른 담당자가 보낸 크리에이터라서": "Creator mà nhân viên khác đã liên hệ, nên các lượt này",
      "발송되지 않은": "không được gửi",
      "시도입니다. 같은 사람이 자주 겹친다면 명단 배분을 조정할 신호입니다.":
        ". Nếu cùng một người bị trùng nhiều lần, đó là dấu hiệu cần chia lại danh sách.",
      "기록이 많아 최근 것부터 일부만 불러왔습니다. 기간이나 검색어로 좁혀 보세요.":
        "Quá nhiều bản ghi — chỉ hiện những mục gần nhất. Hãy thu hẹp theo kỳ hoặc từ khóa.",
      "해당하는 기록이 없습니다.": "Không có bản ghi phù hợp.",
      "중복 시도가 없습니다. 👍": "Không có lượt trùng. 👍",
      "관리자만 볼 수 있습니다": "Chỉ quản trị viên xem được",

      // ── Kết quả ──
      "발송 완료 · ⏸": "đã gửi · ⏸",
      "은 이미 발송돼 보류했습니다.": "bị giữ lại vì đã liên hệ trước đó.",
      "은 보류됩니다 (나머지만 발송).": "sẽ bị giữ lại (chỉ gửi phần còn lại).",
      "⏸ 이미 보낸": "⏸ Đã liên hệ:",
      "⚠️ 이미 보낸": "⚠️ Đã liên hệ:",
      "에게도": "cũng sẽ nhận thư này —",
      "⚠️ 이미 보낸 사람에게도 강제 발송합니다.": "⚠️ Gửi cưỡng chế cả cho người đã liên hệ.",
      "보류된 수신자 — 그래도 보내려면 [강제 발송] 을 켜고 다시 누르세요.":
        "Người nhận bị giữ — bật [gửi cưỡng chế] rồi bấm lại nếu vẫn muốn gửi.",
      "에서": "→",
      "에게 보냅니다.": "người nhận.",
      "⏸ 보류": "⏸ Giữ lại",
      "90일 안에 이미 보낸 주소는 자동 보류됩니다": "Địa chỉ đã liên hệ trong 90 ngày sẽ tự động bị giữ",
      "크리에이터 이메일이 없습니다": "Thiếu email creator",
      "캠페인 제목이 없습니다": "Thiếu tên chiến dịch",
      "유상 협업인데 금액이 없습니다": "Hợp tác trả phí nhưng chưa có số tiền",
      "어필리에이트인데 커미션율이 없습니다": "Affiliate nhưng chưa có tỷ lệ hoa hồng",
      "합니다.": ".",
      // ── Các mảnh còn lại ──
      "— 선택": "— tùy chọn",
      "· 관리자": "· Quản trị",
      // ── Các câu hướng dẫn dài (tạo bằng JS) ──
      "자동 동기화(매일 07:00 KST)가 아직 돈 기록이 없습니다. 눌러서":
        "Đồng bộ tự động (07:00 KST hằng ngày) chưa từng chạy. Bấm để lấy dữ liệu gửi và phản hồi từ",
      "2026-07-01 이후": "từ 2026-07-01",
      "발송·회신을 지금 바로 가져오세요.": "ngay bây giờ.",
      "이후": "trở đi",
      "담당자 메일함을 훑어": "Quét hộp thư nhân viên và điền dữ liệu gửi, phản hồi từ",
      "이후 발송·회신을 채웁니다. 누르기 전까지 갱신되지 않습니다.": "trở đi. Không cập nhật cho đến khi bạn bấm.",
      "아직 기록이 없습니다.": "Chưa có bản ghi.",
      "자동 동기화는": "Đồng bộ tự động chạy lúc",
      "에 돕니다. 아직 한 번도 안 돌았다면, 담당자별 탭의": ". Nếu chưa từng chạy, dùng",
      "로": "ở tab Theo nhân viên để lấy",
      "이후 발송·회신을 지금 바로 가져올 수 있습니다.": "trở đi ngay bây giờ.",
      "담당자 수에 따라 몇 분 걸립니다. 이 도구로 새로 보내는 메일은 기다리지 않아도 바로 잡힙니다.":
        "Mất vài phút tùy số nhân viên. Email gửi mới bằng công cụ này được ghi ngay.",
      "메일함을 읽는 중…": "đang đọc hộp thư…",
      "(인원에 따라 몇 분 걸릴 수 있습니다)": "(có thể mất vài phút tùy số nhân viên)",
      "동기화 완료": "Đồng bộ xong",
      "동기화 끝 (일부 실패)": "Đồng bộ xong (một số lỗi)",
      "· 새 발송": "· lượt gửi mới",
      "· 새 회신": "· phản hồi mới",
      "(2026-07-01 이후, 이미 있던 건 건너뜀)": "(từ 2026-07-01; bỏ qua bản ghi đã có)",
      "실패:": "Lỗi:",
      "등록된 담당자가 없습니다 (NW_ACCOUNTS).": "Chưa đăng ký nhân viên nào (NW_ACCOUNTS).",
      "시간 초과 — 메일이 많아 한 번에 못 끝냈습니다. 다시 누르면 이어서 처리됩니다.":
        "Hết thời gian — quá nhiều thư để xong trong một lần. Bấm lại để tiếp tục.",
      "서버 오류 (HTTP": "Lỗi máy chủ (HTTP",
      "발송 이력 저장소가 아직 연결되지 않았습니다.": "Kho lịch sử gửi chưa được kết nối.",
      "이력이 쌓일 곳이 없어서 담당자별·크리에이터별·중복 시도를 보여줄 수 없습니다. 중복 발송 차단도 함께 꺼져 있는 상태입니다.":
        "Không có nơi lưu lịch sử nên không thể hiển thị theo nhân viên hay lượt trùng. Chặn trùng cũng đang tắt.",
      "붙이는 법 (한 번만)": "Cách kết nối (một lần)",
      "1. Vercel → 이 프로젝트 →": "1. Vercel → dự án này →",
      "탭 →": "tab →",
      "선택 → 프로젝트에": "→ Kết nối vào dự án",
      "→ 맨 위 배포의": "→ ở bản triển khai mới nhất,",
      "연결하면 KV_REST_API_URL / KV_REST_API_TOKEN 이 자동으로 들어갑니다. 무료 티어로 충분합니다.":
        "Kết nối sẽ tự thêm KV_REST_API_URL / KV_REST_API_TOKEN. Gói miễn phí là đủ.",
      "붙이고 나면 담당자별 화면의": "Sau khi kết nối, dùng",
      "로 2026-07-01 이후 발송·회신을 메일함에서 채울 수 있습니다.":
        "ở màn hình Theo nhân viên để điền dữ liệu từ 2026-07-01 trở đi.",
      "먼저 위에서 제품을 고르세요.": "Hãy chọn sản phẩm ở trên trước.",
      "이 제품의 영상이 시트에 없습니다.": "Không có video cho sản phẩm này trong sheet.",
      "영상 칸 3개가 다 찼습니다. 하나를 비우고 다시 고르세요.": "Đã đầy 3 ô video. Hãy xóa bớt rồi chọn lại.",
      "📈 영상 불러오기": "📈 Tải video",
      "· 매출순": "· theo doanh thu",
      "넣음": "đã thêm",
      "명 인식 ·": "được nhận diện ·",
      "명 인식": "được nhận diện",
      "네이버웍스 →": "Naver Works →",
      "IMAP/POP3·SMTP 사용": "quyền IMAP/POP3 · SMTP",
      "CTA 버튼 링크": "Link nút CTA",
      "CTA 버튼 문구": "Chữ trên nút CTA",
      "Next steps — 답장에 뭘 담아 달라고 할지": "Next steps — cần họ trả lời những gì",
      "건": "",
      "관리자": "Quản trị"
    }
  };

  // 숫자가 들어간 문구는 {n} 으로 한 번만 등록한다
  const PATTERNS = {
    en: {
      "{n}명": "{n} people", "{n}건": "{n}", "{n}통": "{n} messages",
      "{n}일": "{n} days", "{n}개": "{n}", "{n}명 인식 ·": "{n} recognized ·",
      "{n}명 인식": "{n} recognized",
      "{n}건 실패": "{n} failed", "{n}건 보류": "{n} held",
      "{n}명에게 발송": "sending to {n}", "1명에게 발송": "sending to 1",
      "{n}명에게 순차 발송 ({n}회 나눠 전송)": "sending to {n} in sequence ({n} batches)",
      "{n}/{n} 처리 중…": "{n}/{n} in progress…",
      "{n}% 회신율": "{n}% reply rate",
      "{n}% 회신율 · 답장 {n}통": "{n}% reply rate · {n} messages",
      "재고 {n}": "stock {n}",
      "{n}개 (판매중)": "{n} (active)",
      "{n}일 안에 이미 보낸 주소는 자동 보류됩니다": "Addresses contacted within {n} days are held automatically",
      "미리보기: {n}": "Preview: {n}",
      "· 실패 {n}명": "· {n} failed",
      "{n}명 인식 ·": "{n} recognized ·",
      "명 인식 ·": "recognized ·",
      "명 인식": "recognized",
      "미리보기: {n} · 총 {n}명": "Preview: {n} · {n} total",
      "USD {n} · 재고 {n}": "USD {n} · stock {n}",
      "{n} · 재고 {n}": "{n} · stock {n}",
      "{n} — 중복 — 건너뜀 (줄 {n})": "{n} — duplicate — skipped (line {n})",
      "{n} — 이메일 형식 오류 (줄 {n})": "{n} — invalid email format (line {n})",
      "{n} — 이메일 없음 (줄 {n})": "{n} — no email (line {n})",
      "{n} · 관리자": "{n} · Admin",
      "미리보기: {e} · 총 {n}명": "Preview: {e} · {n} total",
      "{e} — 중복 — 건너뜀 (줄 {n})": "{e} — duplicate — skipped (line {n})",
      "{x} — 중복 — 건너뜀 (줄 {n})": "{x} — duplicate — skipped (line {n})",
      "{x} — 이메일 형식 오류 (줄 {n})": "{x} — invalid email format (line {n})",
      "{x} — 이메일 없음 (줄 {n})": "{x} — no email (line {n})",
      "{e} — 이메일 형식 오류 (줄 {n})": "{e} — invalid email format (line {n})",
      "{e} — 이메일 없음 (줄 {n})": "{e} — no email (line {n})"
    },
    vi: {
      "{n}명": "{n} người", "{n}건": "{n}", "{n}통": "{n} thư",
      "{n}일": "{n} ngày", "{n}개": "{n}", "{n}명 인식 ·": "nhận diện {n} ·",
      "{n}명 인식": "nhận diện {n}",
      "{n}건 실패": "{n} lỗi", "{n}건 보류": "{n} bị giữ",
      "{n}명에게 발송": "gửi cho {n}", "1명에게 발송": "gửi cho 1",
      "{n}명에게 순차 발송 ({n}회 나눠 전송)": "gửi lần lượt cho {n} ({n} đợt)",
      "{n}/{n} 처리 중…": "đang xử lý {n}/{n}…",
      "{n}% 회신율": "tỷ lệ phản hồi {n}%",
      "{n}% 회신율 · 답장 {n}통": "tỷ lệ phản hồi {n}% · {n} thư",
      "재고 {n}": "tồn {n}",
      "{n}개 (판매중)": "{n} (đang bán)",
      "{n}일 안에 이미 보낸 주소는 자동 보류됩니다": "Địa chỉ đã liên hệ trong {n} ngày sẽ tự động bị giữ",
      "미리보기: {n}": "Xem trước: {n}",
      "· 실패 {n}명": "· {n} lỗi",
      "{n}명 인식 ·": "nhận diện {n} ·",
      "명 인식 ·": "được nhận diện ·",
      "명 인식": "được nhận diện",
      "미리보기: {n} · 총 {n}명": "Xem trước: {n} · tổng {n}",
      "USD {n} · 재고 {n}": "USD {n} · tồn {n}",
      "{n} · 재고 {n}": "{n} · tồn {n}",
      "{n} — 중복 — 건너뜀 (줄 {n})": "{n} — trùng — bỏ qua (dòng {n})",
      "{n} — 이메일 형식 오류 (줄 {n})": "{n} — sai định dạng email (dòng {n})",
      "{n} — 이메일 없음 (줄 {n})": "{n} — thiếu email (dòng {n})",
      "{n} · 관리자": "{n} · Quản trị",
      "미리보기: {e} · 총 {n}명": "Xem trước: {e} · tổng {n}",
      "{e} — 중복 — 건너뜀 (줄 {n})": "{e} — trùng — bỏ qua (dòng {n})",
      "{x} — 중복 — 건너뜀 (줄 {n})": "{x} — trùng — bỏ qua (dòng {n})",
      "{x} — 이메일 형식 오류 (줄 {n})": "{x} — sai định dạng email (dòng {n})",
      "{x} — 이메일 없음 (줄 {n})": "{x} — thiếu email (dòng {n})",
      "{e} — 이메일 형식 오류 (줄 {n})": "{e} — sai định dạng email (dòng {n})",
      "{e} — 이메일 없음 (줄 {n})": "{e} — thiếu email (dòng {n})"
    }
  };

  const KEY = "outreach_lang";
  let LANG = "ko";

  function detect() {
    const saved = (function () { try { return localStorage.getItem(KEY); } catch (_) { return null; } })();
    if (saved && LANGS.some(l => l.code === saved)) return saved;
    const nav = (navigator.language || "ko").toLowerCase();
    if (nav.indexOf("vi") === 0) return "vi";
    if (nav.indexOf("ko") === 0) return "ko";
    return nav.indexOf("en") === 0 ? "en" : "ko";
  }

  const hasKorean = s => /[가-힣]/.test(s);

  // 한 조각을 번역한다. 번역이 없으면 null 을 돌려주고 원문을 그대로 둔다.
  function lookup(raw) {
    if (LANG === "ko") return null;
    const d = DICT[LANG];
    if (!d) return null;
    if (d[raw] != null) return d[raw];

    // 값이 섞인 문구는 그 자리를 표시자로 바꿔 한 번 더 찾는다.
    //   숫자 → {n}  (외따로 선 - 도 "값 없음" 자리이므로 같이 본다)
    //   이메일 → {e}
    // "3명 인식" · "미리보기: a@x.com · 총 1명" 처럼 값만 다른 문구를 한 번만 등록하면 된다.
    const vals = [];
    const pat = raw
      .replace(/[^\s@]+@[^\s@]+\.[^\s@,)]+/g, m => { vals.push({ k: "e", v: m }); return "{e}"; })
      .replace(/\d[\d,.]*|(?<![\w가-힣])-(?![\w가-힣])/g, m => { vals.push({ k: "n", v: m }); return "{n}"; });
    const p = PATTERNS[LANG];
    const fill = (tpl, first) => {
      let i = 0;
      return tpl.replace(/\{[nex]\}/g, m => (m === "{x}" ? first : (i < vals.length ? vals[i++].v : "")));
    };
    if (pat !== raw && p && p[pat] != null) return fill(p[pat], "");

    // 그래도 없으면 맨 앞의 값 하나를 더 표시자로 본다.
    // 명단에서 걸러진 줄은 "bad-line — 이메일 형식 오류 (줄 2)" 처럼 앞이 무엇이든 올 수 있다.
    const head = raw.match(/^\S+(?=\s—\s)/);
    if (head && p) {
      const pat2 = pat.replace(/^\S+(?=\s—\s)/, "{x}");
      if (p[pat2] != null) return fill(p[pat2], head[0]);
    }
    return null;
  }

  // 앞뒤 공백은 살려 둔다 — 조각으로 쪼개진 문장에서 띄어쓰기가 사라지지 않도록
  function translate(text) {
    if (!text || !hasKorean(text)) return null;
    const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    const hit = lookup(m[2]);
    return hit == null ? null : m[1] + hit + m[3];
  }

  const SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, IFRAME: 1 };

  // 언어 단추는 각자 자기 언어로 적혀 있어야 한다 ("한국어" 는 어느 언어에서도 "한국어")
  function inSwitcher(n) {
    for (let e = n.parentNode; e && e !== document.body; e = e.parentNode) {
      if (e.classList && e.classList.contains("langs")) return true;
    }
    return false;
  }

  function walk(root) {
    if (!root) return;
    // 원문을 보관해 둔다 — 언어를 다시 바꿔도 번역본을 또 번역하지 않도록
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        return (n.parentNode && (SKIP[n.parentNode.nodeName] || inSwitcher(n)))
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    let n; while ((n = w.nextNode())) nodes.push(n);
    nodes.forEach(node => {
      const src = node.__ko != null ? node.__ko : node.nodeValue;
      if (!hasKorean(src)) return;
      node.__ko = src;
      const out = translate(src);
      const next = out == null ? src : out;
      if (node.nodeValue !== next) node.nodeValue = next;
    });

    const scope = root.querySelectorAll ? root : document;
    ["placeholder", "title", "aria-label"].forEach(attr => {
      // querySelectorAll 은 root 자신을 포함하지 않는다 — 속성이 root 에 붙어 있으면 놓친다
      const list = [].slice.call(scope.querySelectorAll("[" + attr + "]"));
      if (scope.hasAttribute && scope.hasAttribute(attr)) list.push(scope);
      list.forEach(e => {
        const keep = "__ko_" + attr;
        const src = e[keep] != null ? e[keep] : e.getAttribute(attr);
        if (!src || !hasKorean(src)) return;
        e[keep] = src;
        const out = translate(src);
        const next = out == null ? src : out;
        // 값이 같아도 setAttribute 는 변경 기록을 남긴다 → 옵저버가 다시 돌며 무한 루프
        if (e.getAttribute(attr) !== next) e.setAttribute(attr, next);
      });
    });
  }

  let observer = null;
  function observe() {
    if (observer || typeof MutationObserver === "undefined") return;
    // 화면이 다시 그려질 때마다 새로 생긴 문구를 잡는다 —
    // 렌더 함수마다 번역 호출을 넣지 않아도 되도록
    observer = new MutationObserver(muts => {
      if (LANG === "ko") return;
      let touched = false;
      muts.forEach(m => {
        if (m.type === "attributes" && m.target) { walk(m.target); touched = true; return; }
        m.addedNodes.forEach(nd => {
          if (nd.nodeType === 1) { walk(nd); touched = true; }
          else if (nd.nodeType === 3 && hasKorean(nd.nodeValue)) {
            nd.__ko = nd.nodeValue;
            const out = translate(nd.nodeValue);
            if (out != null && nd.nodeValue !== out) nd.nodeValue = out;
            touched = true;
          }
        });
      });
      return touched;
    });
    observer.observe(document.body, {
      childList: true, subtree: true,
      // title/placeholder 를 나중에 JS 로 넣는 곳이 있다 — 그때도 번역해야 한다
      attributes: true, attributeFilter: ["title", "placeholder", "aria-label"]
    });
  }

  function apply() {
    document.documentElement.setAttribute("lang", LANG);
    walk(document.body);
    const tt = document.querySelector("title");
    if (tt) {
      const src = tt.__ko != null ? tt.__ko : tt.textContent;
      tt.__ko = src;
      const out = translate(src);
      tt.textContent = out == null ? src : out;
    }
  }

  function setLang(code) {
    LANG = LANGS.some(l => l.code === code) ? code : "ko";
    try { localStorage.setItem(KEY, LANG); } catch (_) {}
    apply();
    // 언어 단추 자체도 현재 언어를 반영해야 한다
    document.querySelectorAll("[data-lang]").forEach(b => {
      b.classList.toggle("on", b.getAttribute("data-lang") === LANG);
    });
  }

  // 헤더에 꽂을 언어 선택 단추
  function mount(el) {
    if (!el) return;
    el.innerHTML = LANGS.map(l =>
      '<button type="button" class="langbtn' + (l.code === LANG ? " on" : "") +
      '" data-lang="' + l.code + '">' + l.label + "</button>").join("");
    el.querySelectorAll("[data-lang]").forEach(b => {
      b.addEventListener("click", () => setLang(b.getAttribute("data-lang")));
    });
  }

  function init(mountEl) {
    LANG = detect();
    mount(mountEl);
    apply();
    observe();
  }

  return { init, setLang, mount, apply, get lang() { return LANG; }, LANGS };
});
