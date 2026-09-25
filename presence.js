// 실시간 접속 표시 위젯 — 발송 화면(index.html)·관리자 화면(admin.html) 공용.
//
// 서버리스라 연결을 열어 둘 수 없어서 45초마다 신호(하트비트)를 보낸다. 탭을 보고 있을 때만
// 보내고(다른 탭이면 멈춤 — 저장소 요청을 아끼려고), 창을 닫으면 바로 빠진다.
// 🟢 접속 중(90초 안) · 🟡 자리 비움(5분 안). 어느 화면에 있는지는 관리자에게만 온다.
(function () {
  var VIEW_LABEL = { send: "발송", pipeline: "파이프라인", check: "중복 검사", inhouse: "협업 리스트",
    summary: "담당자별", daily: "일별", weekly: "주차별", conversations: "대화", book: "주소록", blocked: "중복시도" };
  var PAGE_LABEL = { send: "발송 화면", admin: "관리자 페이지" };
  var HEARTBEAT_MS = 45000;
  var opts = null, timer = null, isOpen = false, last = null, started = false, refreshT = null;

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function css() {
    if (document.getElementById("presCss")) return;
    var st = document.createElement("style"); st.id = "presCss";
    st.textContent =
      ".pres{position:relative;display:inline-block;margin-right:6px}" +
      ".pres-btn{border:1px solid #ddd;background:#fff;border-radius:999px;padding:4px 10px;font-size:12.5px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;color:#333}" +
      ".pres-dot{width:8px;height:8px;border-radius:50%;display:inline-block;background:#bbb}" +
      ".pres-dot.on{background:#1e9e4a;box-shadow:0 0 0 3px rgba(30,158,74,.15)}.pres-dot.away{background:#e0a800}" +
      ".pres-panel{position:absolute;right:0;top:calc(100% + 6px);z-index:50;background:#fff;border:1px solid #e3e3e3;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.12);min-width:230px;max-width:320px;padding:8px 0;text-align:left}" +
      ".pres-row{display:flex;align-items:flex-start;gap:8px;padding:6px 12px;font-size:13px}" +
      ".pres-row .pres-dot{margin-top:5px;flex:none}.pres-name{font-weight:600}.pres-sub{color:#888;font-size:11.5px}" +
      ".pres-empty{padding:8px 12px;color:#888;font-size:12.5px}";
    document.head.appendChild(st);
  }
  function panel() {
    var ppl = (last && last.people) || [];
    if (!ppl.length) return '<div class="pres-panel"><div class="pres-empty">지금 접속한 사람이 없습니다</div></div>';
    return '<div class="pres-panel">' + ppl.map(function (p) {
      var st = p.status === "online" ? '<span>접속 중</span>' : '<span>자리 비움 · ' + Math.max(1, Math.round(p.agoSec / 60)) + '분 전</span>';
      var where = (p.page || p.view) ? ' · <span>' + esc(PAGE_LABEL[p.page] || p.page || "") + '</span>' + (p.view && VIEW_LABEL[p.view] ? ' · <span>' + esc(VIEW_LABEL[p.view]) + '</span>' : '') : '';
      return '<div class="pres-row" title="' + esc(p.email) + '"><span class="pres-dot ' + (p.status === "online" ? "on" : "away") + '"></span><div>' +
        '<div class="pres-name">' + esc(p.name) + (p.me ? ' <span class="pres-sub">(<span>나</span>)</span>' : '') + '</div>' +
        '<div class="pres-sub">' + st + where + '</div></div></div>';
    }).join("") + '</div>';
  }
  function render() {
    var el = opts && opts.mount;
    if (!el || !last) return;
    var n = last.online || 0;
    el.className = "pres";
    el.innerHTML = '<button class="pres-btn" type="button"><span class="pres-dot on"></span><span>' + n + '명 접속 중</span></button>' + (isOpen ? panel() : "");
    el.querySelector(".pres-btn").onclick = function (e) { e.stopPropagation(); isOpen = !isOpen; render(); if (isOpen) ping(); };
  }
  function ping(leave) {
    if (!opts) return;
    if (!leave && document.visibilityState !== "visible") return;
    var h = opts.headers && opts.headers();
    if (!h) return;
    try {
      fetch("/api/presence", {
        method: "POST", cache: "no-store", keepalive: Boolean(leave),
        headers: Object.assign({ "content-type": "application/json" }, h),
        body: JSON.stringify(leave ? { leave: true } : { page: opts.page, view: (opts.getView && opts.getView()) || "" })
      }).then(function (r) { return (leave || !r.ok) ? null : r.json(); })
        .then(function (d) { if (d && d.enabled) { last = d; render(); } })
        .catch(function () {});
    } catch (_) {}
  }
  function start(o) {
    if (started) return;
    started = true; opts = o; css();
    ping();
    timer = setInterval(function () { ping(); }, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") ping(); });
    window.addEventListener("pagehide", function () { ping(true); });
    document.addEventListener("click", function () { if (isOpen) { isOpen = false; render(); } });
  }
  // 화면(탭)을 옮기면 곧바로 알린다 — 몰아서 한 번만 (3초)
  function refresh() { if (!started) return; clearTimeout(refreshT); refreshT = setTimeout(function () { ping(); }, 3000); }
  window.Presence = { start: start, refresh: refresh, _state: function () { return { last: last, isOpen: isOpen }; } };
})();
