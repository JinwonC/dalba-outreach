// 발송 이력 (팀 공용) — 같은 크리에이터에게 두 번 나가는 걸 막는다
//
// 담당자가 10명이면 명단이 겹치는 건 시간 문제다. 누가 이미 보냈는지 알 곳이 없으면
// 같은 사람이 d'Alba 메일을 두세 번 받게 되고, 그건 브랜드 인상에 직접 흠이 난다.
// 그래서 발송 직전에 **공용 저장소**를 조회하고, 이력이 있으면 그 건만 보류한다.
//
// ─── 왜 Redis 인가 ───────────────────────────────────────────────
// 서버리스 함수는 인스턴스마다 메모리가 따로 놀고 디스크도 없다. 담당자 A 가 보낸 걸
// 담당자 B 의 요청이 보려면 함수 밖의 공용 저장소가 있어야 한다. Upstash Redis 는
// Vercel 마켓플레이스에서 클릭 몇 번으로 붙고, REST 라 추가 패키지도 필요 없다.
//
// ─── 경합 ────────────────────────────────────────────────────────
// 두 명이 같은 크리에이터에게 동시에 누르면 "조회 → 없음 → 둘 다 발송" 이 된다.
// 그래서 조회가 아니라 **SET NX (없을 때만 쓰기)** 로 자리를 먼저 잡는다.
// 자리를 못 잡으면 이미 누가 가져간 것이므로 보류. 발송이 실패하면 자리를 반납한다.
//
// ─── 환경변수 ────────────────────────────────────────────────────
//   KV_REST_API_URL / KV_REST_API_TOKEN            (Vercel 마켓플레이스가 자동 주입)
//   또는 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//   HISTORY_DAYS   (선택) 재발송 차단 기간, 기본 90일
//
// 저장소를 **아예 설정하지 않은** 배포에서는 이 모듈이 조용히 꺼지고 발송은 그대로 된다
// (기능을 켜기 전과 똑같이 동작). 반대로 **설정은 했는데 저장소가 죽은** 경우는 다르다 —
// 중복인지 알 수 없는 상태이므로 기본적으로 보내지 않고, 담당자가 [강제 발송] 으로만
// 넘어갈 수 있다. 켜 놓고 조용히 중복이 나가는 것이 가장 나쁜 결과이기 때문이다.

const WINDOW_DAYS = Math.max(1, Number(process.env.HISTORY_DAYS || 90));
const TTL_SEC = Math.round(WINDOW_DAYS * 86400);

const LOG_KEY = "outreach:log";          // 성공한 발송
const BLOCK_KEY = "outreach:blocked";    // 중복이라 보류된 시도
const REPLY_KEY = "outreach:replies";    // 크리에이터에게서 온 회신
// 팀 전체 이력 보관 상한. 담당자가 10명이면 몇 달치가 쉽게 만 단위를 넘으므로 넉넉히 둔다.
// 예전 5,000 상한 때문에 그 이상은 오래된 것부터 잘려 나가 집계가 실제보다 적게 잡혔다.
// 필요하면 환경변수로 더 키울 수 있다. (읽기는 청크로 나눠 큰 리스트도 견딘다)
const LOG_MAX = Number(process.env.HISTORY_LOG_MAX) || 100000;
const REPLY_MAX = Number(process.env.HISTORY_REPLY_MAX) || 100000;
const BLOCK_MAX = Number(process.env.HISTORY_BLOCK_MAX) || 20000;
const READ_CHUNK = 3000;                 // LRANGE 한 번에 이만큼씩 — 응답이 너무 커지지 않게

function conf() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

function enabled() { return Boolean(conf()); }

// ─── Redis REST ──────────────────────────────────────────────────
async function cmd(args) {
  const c = conf();
  if (!c) return null;
  const r = await fetch(c.url, {
    method: "POST",
    headers: { authorization: "Bearer " + c.token, "content-type": "application/json" },
    body: JSON.stringify(args)
  });
  const d = await r.json();
  if (d && d.error) throw new Error("이력 저장소 오류: " + d.error);
  return d ? d.result : null;
}

async function pipeline(cmds) {
  const c = conf();
  if (!c || !cmds.length) return [];
  const r = await fetch(c.url + "/pipeline", {
    method: "POST",
    headers: { authorization: "Bearer " + c.token, "content-type": "application/json" },
    body: JSON.stringify(cmds)
  });
  const d = await r.json();
  if (!Array.isArray(d)) throw new Error("이력 저장소 오류: " + ((d && d.error) || "예상 밖 응답"));
  return d.map(x => (x && x.error ? null : x && x.result));
}

// ─── 키 정규화 ───────────────────────────────────────────────────
// a+tag@gmail.com 과 a@gmail.com 은 같은 편지함이다. 태그만 다른 주소로 두 번
// 나가는 걸 막기 위해 + 뒤를 떼고 본다. (점 제거는 Gmail 전용 규칙이라 하지 않는다)
function normEmail(e) {
  const s = String(e == null ? "" : e).trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at < 1) return s;
  let local = s.slice(0, at);
  const dom = s.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  return local + "@" + dom;
}

function normHandle(h) {
  return String(h == null ? "" : h).trim().toLowerCase().replace(/^@+/, "").replace(/\s+/g, "");
}

const emailKey = e => "outreach:sent:e:" + normEmail(e);
const handleKey = h => "outreach:sent:h:" + normHandle(h);

// 한 수신자를 가리키는 키들. 주소가 달라도 핸들이 같으면 같은 사람이므로 둘 다 본다.
function keysOf(r) {
  const ks = [];
  const e = normEmail(r && (r.to || r.email));
  if (e) ks.push(emailKey(e));
  const h = normHandle(r && (r.handle || r.creatorHandle));
  if (h) ks.push(handleKey(h));
  return ks;
}

function parseRec(s) {
  if (!s) return null;
  if (typeof s === "object") return s;
  try { return JSON.parse(s); } catch (_) { return null; }
}

// ─── 조회 ────────────────────────────────────────────────────────
// 수신자 목록을 받아 같은 순서로 [이전 발송기록 | null] 을 돌려준다.
async function lookup(list) {
  const items = Array.isArray(list) ? list : [];
  if (!enabled()) return items.map(() => null);

  // 수신자마다 키 개수가 달라서 인덱스가 밀리지 않도록 위치를 기록해 둔다
  const cmds = [];
  const spans = items.map(r => {
    const ks = keysOf(r);
    const at = cmds.length;
    ks.forEach(k => cmds.push(["GET", k]));
    return { at, n: ks.length };
  });

  const out = await pipeline(cmds);
  return spans.map(s => {
    for (let i = 0; i < s.n; i++) {
      const rec = parseRec(out[s.at + i]);
      if (rec) return rec;
    }
    return null;
  });
}

// ─── 자리 잡기 ───────────────────────────────────────────────────
// 성공하면 { ok:true }, 이미 누가 가져갔으면 { ok:false, prior }.
// force 면 기존 기록을 덮어쓰고 보낸다 (기록에 forced 표시가 남는다).
async function reserve(r, meta, force) {
  if (!enabled()) return { ok: true, skipped: true };

  const keys = keysOf(r);
  if (!keys.length) return { ok: true, skipped: true };

  const rec = {
    to: String((r && r.to) || ""),
    handle: normHandle(r && r.handle) || undefined,
    name: (r && r.creatorName) || undefined,
    at: new Date().toISOString(),
    by: (meta && meta.by) || "",
    byName: (meta && meta.byName) || "",
    campaign: (meta && meta.campaign) || "",
    forced: force ? true : undefined
  };
  const val = JSON.stringify(rec);

  if (force) {
    await pipeline(keys.map(k => ["SET", k, val, "EX", String(TTL_SEC)]));
    return { ok: true, forced: true, record: rec };
  }

  // 첫 키를 NX 로 잡아본다. 실패면 이미 보낸 사람이다.
  const got = await cmd(["SET", keys[0], val, "NX", "EX", String(TTL_SEC)]);
  if (!got) {
    const prior = parseRec(await cmd(["GET", keys[0]]));
    return { ok: false, prior };
  }

  // 나머지 키(핸들)도 잡는다. 하나라도 남이 갖고 있으면 방금 잡은 걸 반납한다 —
  // 주소는 새 주소지만 핸들이 같은, 즉 이미 접촉한 크리에이터인 경우다.
  for (let i = 1; i < keys.length; i++) {
    const ok2 = await cmd(["SET", keys[i], val, "NX", "EX", String(TTL_SEC)]);
    if (!ok2) {
      const prior = parseRec(await cmd(["GET", keys[i]]));
      await pipeline(keys.slice(0, i).map(k => ["DEL", k]));
      return { ok: false, prior };
    }
  }

  return { ok: true, record: rec };
}

// 발송이 실패했으면 자리를 반납한다 — 실패한 주소가 90일간 막히면 안 된다
async function release(r) {
  if (!enabled()) return;
  const keys = keysOf(r);
  if (keys.length) await pipeline(keys.map(k => ["DEL", k]));
}

// 성공한 발송을 시간순 로그에도 남긴다 (조회용, 실패해도 발송에는 영향 없음)
async function log(rec) {
  if (!enabled()) return;
  try {
    await pipeline([
      ["LPUSH", LOG_KEY, JSON.stringify(rec)],
      ["LTRIM", LOG_KEY, "0", String(LOG_MAX - 1)]
    ]);
  } catch (_) { /* 기록 실패가 발송을 막지는 않는다 */ }
}

// ─── 지난 발송 가져오기 (보낸편지함 → 이력) ─────────────────────
// 이 도구를 쓰기 전에 나간 메일도 중복 판정에 들어와야 한다. 안 그러면 툴을 켠 날
// 이전에 접촉한 크리에이터에게 그대로 다시 나간다.
const IMPORTED_KEY = "outreach:imported";   // 같은 메일을 두 번 가져오지 않도록

// 차단 키는 **실제 보낸 날짜 기준**으로 남은 기간만 건다.
// 지금부터 90일로 걸어 버리면 120일 전에 보낸 사람이 앞으로 90일 더 막힌다.
function remainingTtl(at) {
  const t = Date.parse(at || "");
  if (!isFinite(t)) return TTL_SEC;
  const left = TTL_SEC - Math.floor((Date.now() - t) / 1000);
  return left;
}

async function importSend(rec, dedupeId) {
  if (!enabled()) return { skipped: true };

  if (dedupeId) {
    const seen = await cmd(["SISMEMBER", IMPORTED_KEY, String(dedupeId)]);
    if (seen === 1) return { duplicate: true };
  }

  const val = JSON.stringify(rec);
  const ttl = remainingTtl(rec.at);

  // 차단 기간이 이미 지난 메일은 목록에만 남긴다 — 기록으로는 보이되 발송을 막지는 않는다
  let blocked = false;
  if (ttl > 0) {
    const keys = keysOf(rec);
    // 이미 기록이 있으면 덮어쓰지 않는다(NX) — 도구로 보낸 정확한 기록이 우선
    const out = await pipeline(keys.map(k => ["SET", k, val, "NX", "EX", String(ttl)]));
    blocked = out.some(r => r === "OK");
  }

  const tail = [["LPUSH", LOG_KEY, val], ["LTRIM", LOG_KEY, "0", String(LOG_MAX - 1)]];
  if (dedupeId) tail.unshift(["SADD", IMPORTED_KEY, String(dedupeId)]);
  await pipeline(tail);

  return { imported: true, blocking: blocked, expired: ttl <= 0 };
}

// 중복이라 막힌 시도도 남긴다. "누가 누구에게 보내려다 막혔는지" 가 보이면
// 담당자끼리 명단이 얼마나 겹치는지, 배분을 어떻게 고쳐야 하는지가 드러난다.
async function logBlocked(rec) {
  if (!enabled()) return;
  try {
    await pipeline([
      ["LPUSH", BLOCK_KEY, JSON.stringify(rec)],
      ["LTRIM", BLOCK_KEY, "0", String(BLOCK_MAX - 1)]
    ]);
  } catch (_) { /* 기록 실패가 발송을 막지는 않는다 */ }
}

// 최신 순으로 최대 n 개를 읽는다. 한 번에 다 받으면 리스트가 클 때 응답이 너무 커져
// Upstash REST 가 버거우므로 READ_CHUNK 씩 끊어 받는다. 실제 리스트 끝에 닿으면 멈춘다.
async function readList(key, max, n) {
  if (!enabled()) return [];
  const count = Math.max(1, Math.min(Number(n) || 200, max));
  const out = [];
  for (let start = 0; start < count; start += READ_CHUNK) {
    const end = Math.min(start + READ_CHUNK, count) - 1;
    const chunk = await cmd(["LRANGE", key, String(start), String(end)]);
    if (!chunk || !chunk.length) break;
    for (const s of chunk) { const r = parseRec(s); if (r) out.push(r); }
    if (chunk.length < end - start + 1) break;   // 리스트 끝에 도달 — 더 없음
  }
  return out;
}

// 이력 건수만 빠르게 (LLEN — 값을 내려받지 않는다)
async function count(key) {
  if (!enabled()) return 0;
  const n = await cmd(["LLEN", key]);
  return Number(n) || 0;
}

function recent(n) { return readList(LOG_KEY, LOG_MAX, n); }
function recentBlocked(n) { return readList(BLOCK_KEY, BLOCK_MAX, n); }
function recentReplies(n) { return readList(REPLY_KEY, REPLY_MAX, n); }

// ─── 회신 기록 ───────────────────────────────────────────────────
// 받은편지함을 볼 때마다 IMAP 을 뒤지면 담당자가 10명일 때 화면이 못 견딘다.
// 그래서 회신을 한 번 훑어 여기 남기고, 집계는 이 기록만 읽는다.
// 같은 메일을 두 번 세지 않도록 messageId(없으면 계정+발신자+시각)로 판별한다.
async function recordReply(rec, dedupeId) {
  if (!enabled()) return { skipped: true };
  if (dedupeId) {
    const seen = await cmd(["SISMEMBER", IMPORTED_KEY, "r:" + dedupeId]);
    if (seen === 1) return { duplicate: true };
  }
  const tail = [["LPUSH", REPLY_KEY, JSON.stringify(rec)], ["LTRIM", REPLY_KEY, "0", String(REPLY_MAX - 1)]];
  if (dedupeId) tail.unshift(["SADD", IMPORTED_KEY, "r:" + dedupeId]);
  await pipeline(tail);
  return { recorded: true };
}

// 작은 값 하나를 그대로 읽고 쓴다 (자동 실행의 커서·마지막 상태 보관용)
async function readRaw(key) { return enabled() ? cmd(["GET", key]) : null; }
async function writeRaw(key, val) { if (enabled()) await cmd(["SET", key, String(val)]); }

module.exports = {
  enabled, lookup, reserve, release, log, logBlocked, importSend, readRaw, writeRaw,
  recordReply, recent, recentBlocked, recentReplies, count,
  LOG_KEY, BLOCK_KEY, REPLY_KEY,
  normEmail, normHandle,
  WINDOW_DAYS, LOG_MAX, BLOCK_MAX, REPLY_MAX
};
