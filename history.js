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

// 차단 기간(일). 기본 365일 — "5월부터 한 번 접촉한 크리에이터는 다시 안 보낸다"를 지키려면
// 90일로는 5~6월 발송이 풀린다. 환경변수 HISTORY_DAYS 로 바꿀 수 있다(Vercel 에 90 이 들어 있으면 그게 우선).
const WINDOW_DAYS = Math.max(1, Number(process.env.HISTORY_DAYS || 365));
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
// 저장소 호출에는 **반드시 제한시간**을 둔다. 없으면 Upstash 가 느리거나 안 닿을 때 fetch 가
// 끝없이 매달려, 발송 함수 전체가 Vercel 제한시간(60초)에 걸려 죽는다(응답이 JSON 도 아니게 됨).
// 여기서 빨리 실패시키면 호출한 쪽이 잡아 "이력 확인 실패" 로 깔끔히 처리할 수 있다.
const KV_TIMEOUT_MS = Number(process.env.KV_TIMEOUT_MS) || 10000;

async function kvFetch(url, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), KV_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer " + conf().token, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("이력 저장소 응답이 없습니다 (" + KV_TIMEOUT_MS + "ms 초과)");
    throw e;
  } finally { clearTimeout(timer); }
}

async function cmd(args) {
  const c = conf();
  if (!c) return null;
  const r = await kvFetch(c.url, args);
  const d = await r.json();
  if (d && d.error) throw new Error("이력 저장소 오류: " + d.error);
  return d ? d.result : null;
}

async function pipeline(cmds) {
  const c = conf();
  if (!c || !cmds.length) return [];
  const r = await kvFetch(c.url + "/pipeline", cmds);
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

// 핸들은 '@foo', 'foo', 'https://www.tiktok.com/@foo?lang=en' 처럼 여러 모양으로 들어온다.
// URL 로 들어오면 @ 뒤 핸들만 떼어 낸다 — 안 그러면 같은 사람이 URL 키와 핸들 키로 갈라져
// 중복·협업 리스트 대조에서 빠진다.
function normHandle(h) {
  let s = String(h == null ? "" : h).trim();
  const m = s.match(/tiktok\.com\/@([A-Za-z0-9._]+)/i);
  if (m) s = m[1];
  return s.toLowerCase().replace(/^@+/, "").replace(/\s+/g, "").replace(/[/?#].*$/, "");
}
// 예전 정규화(URL 을 풀지 않음) — 재색인 때 키가 달라진 기록을 찾는 데만 쓴다
function legacyNormHandle(h) {
  return String(h == null ? "" : h).trim().toLowerCase().replace(/^@+/, "").replace(/\s+/g, "");
}

// 중복(재발송) 계산에서 **제외할 발신자** — 기본은 **아무도 없음**(전원 중복 판정 대상).
//   · 여기 든 사람은 이미 보낸 크리에이터라도 다른 사람의 발송을 막지 않고, 본인도 안 막힌다.
// 기본값을 비워, 관리자 포함 **전원**이 중복 판정에 포함된다. 특정 계정을 빼야 할 일이 생기면
// 환경변수 DEDUP_IGNORE_SENDERS 에만 넣는다(콤마·세미콜론·공백·줄바꿈 구분). 코드에 사람을 박지 않는다.
const IGNORE_SENDERS = new Set(
  String(process.env.DEDUP_IGNORE_SENDERS || "")
    .split(/[\s,;]+/).map(s => normEmail(s)).filter(Boolean)
);
function isIgnoredSender(by) {
  return IGNORE_SENDERS.has(normEmail(by));
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

// ─── 이메일 ↔ 핸들 연결 (브리지) ─────────────────────────────────
// 같은 크리에이터가 어떤 발송엔 이메일만, 어떤 발송엔 핸들까지 적혀 기록된다.
// 한 번이라도 이메일+핸들이 함께 기록되면 그 짝을 남겨 두고, 이후 한쪽만 있어도
// 다른 쪽 키까지 함께 대조한다 (핸들 없이 보낸 발송 · 보낸편지함에서 가져온 발송 보완).
//   outreach:bridge:e2h        HASH  이메일 → 핸들
//   outreach:bridge:h:<핸들>   SET   그 핸들로 기록된 이메일들
const BRIDGE_E2H = "outreach:bridge:e2h";
const bridgeHKey = h => "outreach:bridge:h:" + h;
const BRIDGE_VER_KEY = "outreach:bridge:ver";
const BRIDGE_PROGRESS_KEY = "outreach:bridge:progress";
// v3: 연결 + 발송 로그 **전체**의 차단 키를 현재 차단 기간으로 다시 건다(만료된 5~6월 발송 되살리기).
// 차단 기간을 바꾸면 버전이 달라져 다시 돈다.
const BRIDGE_VER = "3:" + WINDOW_DAYS;

function linkCmds(email, handle) {
  const e = normEmail(email), h = normHandle(handle);
  if (!e || !h || e.indexOf("@") < 1) return [];
  return [["HSET", BRIDGE_E2H, e, h], ["SADD", bridgeHKey(h), e]];
}

// 수신자 목록 → 각자의 연결된 핸들·이메일 (자기 자신은 뺀다). 한 번의 파이프라인으로 읽는다.
async function bridge(list) {
  const items = Array.isArray(list) ? list : [];
  const empty = () => ({ handles: [], emails: [] });
  if (!enabled() || !items.length) return items.map(empty);
  const cmds = [], spans = [];
  items.forEach(r => {
    const e = normEmail(r && (r.to || r.email)), h = normHandle(r && (r.handle || r.creatorHandle));
    const s = { e, h, ei: -1, hi: -1 };
    if (e) { s.ei = cmds.length; cmds.push(["HGET", BRIDGE_E2H, e]); }
    if (h) { s.hi = cmds.length; cmds.push(["SMEMBERS", bridgeHKey(h)]); }
    spans.push(s);
  });
  let out = [];
  try { out = cmds.length ? await pipeline(cmds) : []; } catch (_) { return items.map(empty); }
  return spans.map(s => {
    const lh = s.ei >= 0 ? normHandle(out[s.ei]) : "";
    const le = s.hi >= 0 && Array.isArray(out[s.hi]) ? out[s.hi].map(normEmail) : [];
    return {
      handles: lh && lh !== s.h ? [lh] : [],
      emails: [...new Set(le)].filter(x => x && x !== s.e)
    };
  });
}

// 연결로 찾은 추가 키 (자기 키는 제외)
function aliasKeysOf(br) {
  const ks = [];
  ((br && br.emails) || []).forEach(e => ks.push(emailKey(e)));
  ((br && br.handles) || []).forEach(h => ks.push(handleKey(h)));
  return ks;
}

function parseRec(s) {
  if (!s) return null;
  if (typeof s === "object") return s;
  try { return JSON.parse(s); } catch (_) { return null; }
}

// ─── 조회 ────────────────────────────────────────────────────────
// 수신자 목록을 받아 같은 순서로 [이전 발송기록 | null] 을 돌려준다.
async function lookup(list, me) {
  const items = Array.isArray(list) ? list : [];
  const meN = normEmail(me || "");
  if (!enabled()) return items.map(() => null);

  // 수신자마다 키 개수가 달라서 인덱스가 밀리지 않도록 위치를 기록해 둔다.
  // 자기 키(이메일·핸들)를 먼저, 연결된 키(브리지)를 뒤에 — 직접 일치가 우선이다.
  const links = await bridge(items);
  const cmds = [];
  const spans = items.map((r, idx) => {
    const ks = keysOf(r).concat(aliasKeysOf(links[idx]));
    const at = cmds.length;
    ks.forEach(k => cmds.push(["GET", k]));
    return { at, n: ks.length };
  });

  const out = await pipeline(cmds);
  // 담당자 보낸편지함(주소록)도 대조 — 단체·숨은참조로 보낸 상대
  const emailsOf = idx => [normEmail(items[idx] && (items[idx].to || items[idx].email))].concat(links[idx].emails || []).filter(Boolean);
  const bp = await bookSentPriors([].concat(...items.map((_, i) => emailsOf(i))));
  return spans.map((s, idx) => {
    const cands = [];
    for (let i = 0; i < s.n; i++) {
      const rec = parseRec(out[s.at + i]);
      // 제외 발신자(예: minju)의 기록은 '이미 보낸 것'으로 치지 않는다
      if (rec && !isIgnoredSender(rec.by)) cands.push(rec);
    }
    emailsOf(idx).forEach(e => (bp.get(e) || []).forEach(p => { if (!isIgnoredSender(p.by)) cands.push(p); }));
    if (!cands.length) return null;
    // 보내는 사람을 알면 **다른 담당자** 기록을 우선 (본인 기록은 보류 사유가 아니다)
    if (meN) { const other = cands.find(c => normEmail(c.by) !== meN); if (other) return other; }
    return cands[0];
  });
}

// ─── 자리 잡기 ───────────────────────────────────────────────────
// 성공하면 { ok:true }, 이미 누가 가져갔으면 { ok:false, prior }.
// force 면 기존 기록을 덮어쓰고 보낸다 (기록에 forced 표시가 남는다).
async function reserve(r, meta, force) {
  if (!enabled()) return { ok: true, skipped: true };

  const keys = keysOf(r);
  if (!keys.length) return { ok: true, skipped: true };

  // 제외 발신자(예: minju)는 중복 판정에서 빠진다 — 막히지도, 남을 막지도 않는다.
  // 차단 키를 남기지 않아 이 발송은 다른 담당자의 발송을 가로막지 않는다.
  if (isIgnoredSender(meta && meta.by)) return { ok: true, skipped: true };

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

  // 중복은 **다른 담당자**가 이미 보낸 경우에만 막는다. 본인이 이미 보낸 크리에이터에게
  // 직접 후속(재발송)을 보내는 건 막지 않는다 — 그 자리는 덮어쓰고 그대로 보낸다.
  const me = normEmail((meta && meta.by) || "");
  const created = [];                 // 이번에 **새로** 잡은 키 (실패 시 반납 대상)
  let resent = false;                 // 본인 자리 위에 다시 보낸 경우
  let approved = false;               // 관리자 승인으로 통과한 경우
  let approvalChecked = false;        // 승인 조회는 막힐 때 한 번만 한다

  // ── 연결된 키(브리지) 먼저 확인 — **읽기만** 한다 ──
  // 예: 예전에 이메일 A 로만 보냈던 크리에이터(핸들 X 와 연결됨)에게 지금 이메일 B + 핸들 X 로
  // 보내면, 자기 키(B·X)에는 기록이 없어도 연결된 A 키에 다른 담당자 기록이 있다 → 막는다.
  // 연결 키에는 자리를 잡지 않는다(보내는 주소가 아니므로) — 실패 시 반납할 것도 없다.
  const br = (await bridge([r]))[0] || { handles: [], emails: [] };
  const aliasKeys = aliasKeysOf(br).filter(k => keys.indexOf(k) < 0);
  if (aliasKeys.length) {
    const vals = await pipeline(aliasKeys.map(k => ["GET", k]));
    for (let i = 0; i < aliasKeys.length; i++) {
      const prior = parseRec(vals[i]);
      if (!prior || isIgnoredSender(prior.by)) continue;
      if (me && normEmail(prior.by) === me) continue;       // 본인 기록이면 재발송 허용
      if (me) {
        if (!approvalChecked) { approved = await isApproved(r, me); approvalChecked = true; }
        if (approved) continue;
      }
      return { ok: false, prior: Object.assign({}, prior, { linked: true }) };
    }
  }

  // ── 다른 담당자 보낸편지함(주소록) 대조 — 단체·참조·숨은참조로 이미 보낸 상대도 막는다 ──
  const bookEmails = [normEmail(r && (r.to || r.email))].concat(br.emails || []).filter(Boolean);
  if (bookEmails.length) {
    const bp = await bookSentPriors(bookEmails);
    const priors = [].concat(...bookEmails.map(x => bp.get(x) || []));
    for (const p of priors) {
      if (isIgnoredSender(p.by)) continue;
      if (me && p.by === me) continue;                       // 본인이 보낸 적 있으면 재발송 허용
      if (me) {
        if (!approvalChecked) { approved = await isApproved(r, me); approvalChecked = true; }
        if (approved) continue;
      }
      return { ok: false, prior: p };
    }
  }

  for (let i = 0; i < keys.length; i++) {
    const got = await cmd(["SET", keys[i], val, "NX", "EX", String(TTL_SEC)]);
    if (got) { created.push(keys[i]); continue; }

    const prior = parseRec(await cmd(["GET", keys[i]]));
    // 제외 발신자(예: minju)가 잡아 둔 자리, 또는 본인이 잡은 자리면 발송 허용 —
    // 덮어써서 새 발신자가 주인이 되게 하고 계속한다 (이후 진짜 중복은 이 발신자 기준으로 막힌다).
    if (prior && (isIgnoredSender(prior.by) || (me && normEmail(prior.by) === me))) {
      await cmd(["SET", keys[i], val, "EX", String(TTL_SEC)]);
      if (me && normEmail(prior.by) === me) resent = true;
      continue;
    }
    // 관리자가 이 담당자에게 이 크리에이터 발송을 **승인**했으면 통과한다.
    // 자리를 이 담당자로 덮어써 주인이 되게 한다 (이후 재발송은 자유, 남은 그대로 막힌다).
    if (me) {
      if (!approvalChecked) { approved = await isApproved(r, me); approvalChecked = true; }
      if (approved) { await cmd(["SET", keys[i], val, "EX", String(TTL_SEC)]); continue; }
    }
    // 다른 담당자 자리 → 이번에 새로 잡은 것만 반납하고 보류 (본인 자리는 건드리지 않는다)
    if (created.length) await pipeline(created.map(k => ["DEL", k]));
    return { ok: false, prior };
  }

  return { ok: true, record: rec, resent: resent || undefined, approved: approved || undefined };
}

// ─── 관리자 승인 (막힌 담당자에게 그 크리에이터 발송을 허가) ───────
// 중복으로 막힌 발송을 관리자가 승인하면, **그 담당자 본인이** 자기 계정으로 보낼 수 있다.
// (관리자가 대신 보내는 '강제 발송' 과 달리, 발신자는 원래 담당자 그대로다.)
// HASH 필드 "<담당자>::<차단키>" 에 승인을 남겨 두고, reserve 가 막을 때 이걸 확인한다.
// 승인 후 담당자가 성공적으로 보내면 그 자리의 주인이 되므로, 그 뒤로는 재발송이 자유롭다.
const APPROVE_KEY = "outreach:approvals";
function approvalField(staff, key) { return normEmail(staff) + "::" + key; }
function approvalFieldsOf(r, staff) { return keysOf(r).map(k => approvalField(staff, k)); }

async function approveSend(r, staff, meta) {
  if (!enabled()) return { skipped: true };
  const keys = keysOf(r);
  const s = normEmail(staff);
  if (!keys.length || !s) return { skipped: true };
  const rec = {
    by: s, to: String((r && r.to) || ""), handle: normHandle(r && r.handle) || undefined,
    name: (r && (r.creatorName || r.name)) || undefined,
    at: new Date().toISOString(), approvedBy: (meta && meta.approvedBy) || ""
  };
  await pipeline(keys.map(k => ["HSET", APPROVE_KEY, approvalField(s, k), JSON.stringify(rec)]));
  return { approved: true, keys: keys.length };
}

// 이 담당자(staff)가 이 크리에이터에게 보내도록 승인돼 있는가
async function isApproved(r, staff) {
  if (!enabled()) return false;
  const fields = approvalFieldsOf(r, staff);
  if (!fields.length || !normEmail(staff)) return false;
  const out = await pipeline(fields.map(fld => ["HGET", APPROVE_KEY, fld]));
  return out.some(v => v);
}

async function revokeApproval(r, staff) {
  if (!enabled()) return;
  const fields = approvalFieldsOf(r, staff);
  if (fields.length) await pipeline(fields.map(fld => ["HDEL", APPROVE_KEY, fld]));
}

// 승인된 필드 전체를 Set 으로 (관리자 화면에서 '승인됨' 표시용 — 한 번만 읽는다)
async function approvalsIndex() {
  if (!enabled()) return new Set();
  const flat = await cmd(["HGETALL", APPROVE_KEY]);
  const set = new Set();
  if (Array.isArray(flat)) { for (let i = 0; i < flat.length; i += 2) set.add(flat[i]); }
  else if (flat && typeof flat === "object") { Object.keys(flat).forEach(k => set.add(k)); }
  return set;
}

// 승인 내역 전체를 레코드로 (엑셀 내보내기용). 같은 승인이 이메일·핸들 두 필드에 저장되므로
// (담당자+크리에이터) 기준으로 중복을 없앤다. 각 레코드: { by(담당자), to(이메일), handle, name, at(승인일), approvedBy(관리자) }
async function allApprovals() {
  if (!enabled()) return [];
  const flat = await cmd(["HGETALL", APPROVE_KEY]);
  const seen = new Set(), out = [];
  const push = v => {
    const p = parseRec(v); if (!p) return;
    const k = normEmail(p.by) + "|" + normEmail(p.to) + "|" + normHandle(p.handle);
    if (seen.has(k)) return; seen.add(k); out.push(p);
  };
  if (Array.isArray(flat)) { for (let i = 0; i + 1 < flat.length; i += 2) push(flat[i + 1]); }
  else if (flat && typeof flat === "object") { Object.keys(flat).forEach(k => push(flat[k])); }
  return out;
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
    ].concat(linkCmds(rec && rec.to, rec && rec.handle)));   // 이메일+핸들이 함께 있으면 연결을 남긴다
  } catch (_) { /* 기록 실패가 발송을 막지는 않는다 */ }
}

// ─── 메일함별 "보낸 적 있는 주소" (회신 판별 전용) ─────────────────
// 보낸편지함의 모든 외부 수신자(받는사람·참조·숨은참조, 인원 제한 없음)를 메일함마다 모아 둔다.
// 발송 이력(중복 차단)에는 넣지 않는다 — 단체 메일은 공지일 수 있어 중복 판정엔 쓰지 않지만,
// 그 사람이 **이 메일함으로 답장했다면** 그건 우리가 보낸 메일에 대한 회신이 맞다.
const sentToKey = acct => "outreach:sentto:" + normEmail(acct);
async function addSentTo(acct, emails) {
  if (!enabled()) return 0;
  const list = [...new Set((emails || []).map(normEmail).filter(e => e && e.indexOf("@") > 0))];
  const key = sentToKey(acct);
  for (let i = 0; i < list.length; i += 500) await pipeline(list.slice(i, i + 500).map(e => ["SADD", key, e]));
  return list.length;
}
async function sentToSet(acct) {
  if (!enabled()) return new Set();
  try { const m = await cmd(["SMEMBERS", sentToKey(acct)]); return new Set(Array.isArray(m) ? m : []); }
  catch (_) { return new Set(); }
}

// ─── 주소록 (메일함별 보낸/받은 외부 주소) ───────────────────────────
// 관리자 '📒 주소록' 용. 메일함마다 방향별(sent/recv) HASH 하나: 필드=주소, 값=JSON
//   { n: 메일 수, first/last: 처음·마지막 날짜, subj: 최근 제목, name, box: 폴더(받은 쪽) }
// 본문은 저장하지 않는다. 한 번 훑은 메일은 커서가 넘어가므로 같은 메일을 두 번 세지 않는다.
const bookKey = (dir, acct) => "outreach:book:" + dir + ":" + normEmail(acct);
// agg: Map(주소 → {n, first, last, subj, name, box}) — 이번에 훑은 분량을 합쳐 기존 값에 더한다
const BOOK_OWNERS = "outreach:book:owners";   // 보낸 주소록이 있는 메일함 목록 (중복 차단 대조용)
async function bookMerge(dir, acct, agg) {
  if (!enabled() || !agg || !agg.size) return 0;
  const key = bookKey(dir, acct);
  if (dir === "sent") { try { await cmd(["SADD", BOOK_OWNERS, normEmail(acct)]); } catch (_) {} }
  const emails = [...agg.keys()];
  for (let i = 0; i < emails.length; i += 400) {
    const part = emails.slice(i, i + 400);
    const cur = await cmd(["HMGET", key].concat(part));
    const cmds = part.map((e, j) => {
      const a = agg.get(e), c = parseRec(cur && cur[j]) || {};
      const newer = String(a.last || "") >= String(c.last || "");
      const m = {
        n: (Number(c.n) || 0) + (Number(a.n) || 0),
        first: [c.first, a.first].filter(Boolean).sort()[0] || "",
        last: [c.last, a.last].filter(Boolean).sort().pop() || "",
        subj: newer ? (a.subj || c.subj || "") : (c.subj || a.subj || ""),
        name: c.name || a.name || "",
        box: newer ? (a.box || c.box || "") : (c.box || a.box || "")
      };
      return ["HSET", key, e, JSON.stringify(m)];
    });
    await pipeline(cmds);
  }
  return emails.length;
}
// ─── 중복 차단: 모든 담당자 보낸편지함(주소록) 대조 ────────────────────
// 네이버웍스에서 직접 보낸 메일 — 단체 발송·참조·숨은참조까지 — 의 상대도 '이미 접촉한 사람'이다.
// 이메일들 → Map(이메일 → [{by: 보낸 메일함, at: 마지막 발송, n, source:"mailbox"}]) (차단 기간 안만)
function withinWindow(at) { const t = Date.parse(at || ""); return !isFinite(t) || (Date.now() - t) <= WINDOW_DAYS * 86400e3; }
async function bookSentPriors(emails) {
  const list = [...new Set((emails || []).map(normEmail).filter(e => e && e.indexOf("@") > 0))];
  const out = new Map();
  if (!enabled() || !list.length) return out;
  let owners = [];
  try { owners = (await cmd(["SMEMBERS", BOOK_OWNERS])) || []; } catch (_) { return out; }
  if (!owners.length) return out;
  let res = [];
  try { res = await pipeline(owners.map(o => ["HMGET", bookKey("sent", o)].concat(list))); } catch (_) { return out; }
  let names = null;
  const nameOf = o => {
    if (!names) { names = new Map(); try { require("./auth.js").parseAccounts().forEach(a => names.set(normEmail(a.email), a.name || "")); } catch (_) {} }
    return names.get(normEmail(o)) || "";
  };
  owners.forEach((o, i) => {
    const vals = res[i] || [];
    list.forEach((e, j) => {
      const b = parseRec(vals[j]);
      if (!b) return;
      const at = b.last || b.first || "";
      if (!withinWindow(at)) return;
      const arr = out.get(e) || [];
      arr.push({ to: e, by: normEmail(o), byName: nameOf(o), at, n: Number(b.n) || 1, campaign: "", source: "mailbox" });
      out.set(e, arr);
    });
  });
  out.forEach(arr => arr.sort((a, b) => String(b.at || "").localeCompare(String(a.at || ""))));
  return out;
}

// 여러 메일함의 주소록에서 여러 주소를 한 번에 — Map(주소 → [{owner, n, first, last, box}]) (기간 제한 없음)
async function bookGetMany(dir, accts, emails) {
  const list = [...new Set((emails || []).map(normEmail).filter(e => e && e.indexOf("@") > 0))];
  const owners = [...new Set((accts || []).map(normEmail).filter(Boolean))];
  const out = new Map();
  if (!enabled() || !list.length || !owners.length) return out;
  for (let i = 0; i < list.length; i += 400) {
    const part = list.slice(i, i + 400);
    let res = [];
    try { res = await pipeline(owners.map(o => ["HMGET", bookKey(dir, o)].concat(part))); } catch (_) { continue; }
    owners.forEach((o, k) => (res[k] || []).forEach((v, j) => {
      const b = parseRec(v);
      if (!b) return;
      const arr = out.get(part[j]) || [];
      arr.push(Object.assign({ owner: o }, b));
      out.set(part[j], arr);
    }));
  }
  return out;
}

async function bookOwners() {
  if (!enabled()) return [];
  try { return (await cmd(["SMEMBERS", BOOK_OWNERS])) || []; } catch (_) { return []; }
}

async function bookCount(dir, acct) {
  if (!enabled()) return 0;
  try { return Number(await cmd(["HLEN", bookKey(dir, acct)])) || 0; } catch (_) { return 0; }
}
// 메일함별 마지막 동기화 상태 (주소록 탭에 표시 — 어느 폴더를 보낸편지함으로 읽었는지, 오류 등)
const syncInfoKey = acct => "outreach:syncinfo:" + normEmail(acct);
async function saveSyncInfo(acct, info) {
  if (!enabled()) return;
  try { await cmd(["SET", syncInfoKey(acct), JSON.stringify(Object.assign({ at: new Date().toISOString() }, info))]); } catch (_) {}
}
async function syncInfo(acct) {
  if (!enabled()) return null;
  try { return parseRec(await cmd(["GET", syncInfoKey(acct)])); } catch (_) { return null; }
}
async function bookAll(dir, acct) {
  if (!enabled()) return [];
  const flat = await cmd(["HGETALL", bookKey(dir, acct)]);
  const out = [];
  const push = (e, v) => { const r = parseRec(v); if (r) out.push(Object.assign({ email: e }, r)); };
  if (Array.isArray(flat)) { for (let i = 0; i + 1 < flat.length; i += 2) push(flat[i], flat[i + 1]); }
  else if (flat && typeof flat === "object") Object.keys(flat).forEach(k => push(k, flat[k]));
  return out;
}

// ─── 메일 데이터베이스 (본문까지) ──────────────────────────────────
// 담당자 메일함의 보낸·받은 메일(회사 밖 상대)을 한 통씩 저장한다:
//   outreach:msg:<메일함>            HASH  messageId → { dir(in|out), at, from, to[], cc[], subject, box, text }
//   outreach:msgp:<메일함>:<상대>    SET   그 상대와 주고받은 messageId 들 (상대별 조회 색인)
// 같은 메일은 한 번만 저장(HSETNX). 이 저장소는 **중복 발송 차단도 함께 쓰므로**, 본문이 전체 용량을
// 잡아먹지 않게 상한(MSG_STORE_MAX_MB, 기본 150MB)을 둔다 — 넘으면 본문 없이 기록만 남긴다.
const MSG_BYTES_KEY = "outreach:msg:bytes";
const MSG_CAP = Math.max(1, Number(process.env.MSG_STORE_MAX_MB) || 150) * 1024 * 1024;
const msgKey = acct => "outreach:msg:" + normEmail(acct);
const msgPeerKey = (acct, peer) => "outreach:msgp:" + normEmail(acct) + ":" + normEmail(peer);
async function storeMessages(acct, items) {
  const list = (items || []).filter(m => m && m.id);
  if (!enabled() || !list.length) return { stored: 0, noText: 0, full: false };
  let used = Number(await cmd(["GET", MSG_BYTES_KEY])) || 0;
  let stored = 0, noText = 0, full = used >= MSG_CAP;
  const key = msgKey(acct);
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const cmds = [], sizes = [], pos = [];
    let add = 0;
    for (const m of chunk) {
      const rec = Object.assign({}, m); delete rec.peers;
      if ((full || used + add >= MSG_CAP) && rec.text) { full = true; delete rec.text; rec.textDropped = true; }
      const val = JSON.stringify(rec);
      const size = Buffer.byteLength(val);
      pos.push(cmds.length); sizes.push({ size, dropped: Boolean(rec.textDropped) });
      cmds.push(["HSETNX", key, m.id, val]);
      (m.peers || []).forEach(p => { if (normEmail(p)) cmds.push(["SADD", msgPeerKey(acct, p), m.id]); });
      add += size;
    }
    const out = await pipeline(cmds);
    let newBytes = 0;
    pos.forEach((p, j) => { if (Number(out[p]) === 1) { stored++; newBytes += sizes[j].size; if (sizes[j].dropped) noText++; } });
    if (newBytes) { used = Number(await cmd(["INCRBY", MSG_BYTES_KEY, String(newBytes)])) || (used + newBytes); }
    if (used >= MSG_CAP) full = true;
  }
  return { stored, noText, full };
}
async function messageCount(acct) {
  if (!enabled()) return 0;
  try { return Number(await cmd(["HLEN", msgKey(acct)])) || 0; } catch (_) { return 0; }
}
async function messageUsage() {
  if (!enabled()) return { usedMB: 0, capMB: 0, full: false };
  const used = Number(await cmd(["GET", MSG_BYTES_KEY]).catch(() => 0)) || 0;
  return { usedMB: Math.round(used / 1048576 * 10) / 10, capMB: Math.round(MSG_CAP / 1048576), full: used >= MSG_CAP };
}
// 한 상대와 주고받은 저장된 메일 (오래된 → 최신)
async function messagesWith(acct, peer) {
  if (!enabled()) return [];
  const ids = await cmd(["SMEMBERS", msgPeerKey(acct, peer)]);
  if (!Array.isArray(ids) || !ids.length) return [];
  const vals = await cmd(["HMGET", msgKey(acct)].concat(ids));
  return (vals || []).map(parseRec).filter(Boolean).sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
}

// ─── 연결(브리지) 재구성 — 지난 발송 로그에서 한 번 채운다 ─────────
// 새 발송은 log() 가 그때그때 연결을 남긴다. 이 함수는 **이미 쌓인** 기록에서
// 이메일+핸들 짝을 모아 채우고, 예전 정규화(URL 을 안 풀던)로 잘못 잡힌 핸들 차단 키를
// 올바른 핸들 키로 다시 건다. 예산 안에서 나눠 처리하고, 다 끝나면 버전 표시를 남긴다.
async function bridgeReady() {
  if (!enabled()) return true;
  try { return (await cmd(["GET", BRIDGE_VER_KEY])) === BRIDGE_VER; } catch (_) { return true; }
}

async function rebuildBridge(opts) {
  if (!enabled()) return { skipped: true };
  const o = opts || {};
  const deadline = Date.now() + Math.max(3000, Number(o.budgetMs) || 15000);
  const all = await recent(LOG_MAX);

  // 짝과 재색인 대상을 중복 없이 모은다. 정렬해 두면 실행이 나뉘어도 순서가 안정적이다.
  const pairs = new Map();      // "e|h" → [e, h]
  const rekeys = new Map();     // handleKey → rec (가장 최근 발송 기준)
  for (const r of all) {
    if (!r) continue;
    const e = normEmail(r.to), h = normHandle(r.handle);
    if (e && h && e.indexOf("@") > 0) pairs.set(e + "|" + h, [e, h]);
    // 이메일·핸들 차단 키마다 가장 최근 발송 기록으로 다시 건다 (비어 있을 때만 — NX)
    if (isIgnoredSender(r.by)) continue;
    [e ? emailKey(e) : "", h ? handleKey(h) : ""].filter(Boolean).forEach(k => {
      const cur = rekeys.get(k);
      if (!cur || String(r.at || "") > String(cur.at || "")) rekeys.set(k, r);
    });
  }
  const jobs = [];
  [...pairs.keys()].sort().forEach(k => { const [e, h] = pairs.get(k); jobs.push(...linkCmds(e, h)); });
  [...rekeys.keys()].sort().forEach(k => {
    const r = rekeys.get(k), ttl = remainingTtl(r.at);
    if (ttl > 0 && !isIgnoredSender(r.by)) {
      const val = JSON.stringify({ to: r.to || "", handle: normHandle(r.handle), name: r.name || undefined,
        at: r.at || "", by: r.by || "", byName: r.byName || "", campaign: r.campaign || "" });
      jobs.push(["SET", k, val, "NX", "EX", String(ttl)]);
    }
  });

  let start = 0;
  try { start = Number(await cmd(["GET", BRIDGE_PROGRESS_KEY])) || 0; } catch (_) {}
  if (start > jobs.length) start = 0;
  let i = start;
  const CHUNK = 500;
  while (i < jobs.length && Date.now() < deadline) {
    await pipeline(jobs.slice(i, i + CHUNK));
    i = Math.min(jobs.length, i + CHUNK);
  }
  const done = i >= jobs.length;
  await pipeline(done
    ? [["SET", BRIDGE_VER_KEY, BRIDGE_VER], ["DEL", BRIDGE_PROGRESS_KEY]]
    : [["SET", BRIDGE_PROGRESS_KEY, String(i)]]);
  return { done, pairs: pairs.size, rekeyed: rekeys.size, processed: i - start, total: jobs.length };
}

// 여러 건을 한 번에 가져온다 — importSend 를 한 통씩 부르면 저장소 왕복이 수천 번이라 느리다.
// 규칙은 importSend 와 같다: 차단 키는 (남은 기간이 있으면) 비어 있을 때만 잡고, 로그는 처음 가져올 때만.
async function importSends(list) {
  const items = (list || []).filter(x => x && x.rec);
  const res = { imported: 0, duplicate: 0, blocking: 0, expired: 0 };
  if (!enabled() || !items.length) return res;
  for (let i = 0; i < items.length; i += 300) {
    const chunk = items.slice(i, i + 300);
    const seen = await pipeline(chunk.map(x => x.id ? ["SISMEMBER", IMPORTED_KEY, String(x.id)] : ["ECHO", "0"]));
    const cmds = [], setPos = [];
    let logged = false;
    const batchIds = new Set();
    chunk.forEach((x, j) => {
      const val = JSON.stringify(x.rec), ttl = remainingTtl(x.rec.at);
      const pos = [];
      if (ttl > 0) keysOf(x.rec).forEach(k => { pos.push(cmds.length); cmds.push(["SET", k, val, "NX", "EX", String(ttl)]); });
      setPos.push(pos);
      const dup = (x.id && (Number(seen[j]) === 1 || batchIds.has(x.id)));
      if (dup) { res.duplicate++; return; }
      if (x.id) { batchIds.add(x.id); cmds.push(["SADD", IMPORTED_KEY, String(x.id)]); }
      cmds.push(["LPUSH", LOG_KEY, val]); logged = true;
      res.imported++; if (ttl <= 0) res.expired++;
    });
    if (logged) cmds.push(["LTRIM", LOG_KEY, "0", String(LOG_MAX - 1)]);
    if (!cmds.length) continue;
    const out = await pipeline(cmds);
    setPos.forEach(ps => { if (ps.some(p => out[p] === "OK")) res.blocking++; });
  }
  return res;
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

  // 같은 메일을 두 번 **기록(로그)** 하지 않으려는 표시. 단, 차단키는 아래에서 항상 다시
  // 확인한다 — 차단 기간(HISTORY_DAYS)을 늘린 뒤 재동기화하면, 예전에 가져와 만료된
  // 크리에이터도 다시 차단되도록. (여기서 그냥 return 하면 만료된 차단이 되살아나지 않는다)
  const seen = dedupeId ? (await cmd(["SISMEMBER", IMPORTED_KEY, String(dedupeId)]) === 1) : false;

  const val = JSON.stringify(rec);
  const ttl = remainingTtl(rec.at);

  // 차단 기간이 이미 지난 메일은 목록에만 남긴다 — 기록으로는 보이되 발송을 막지는 않는다
  let blocked = false;
  if (ttl > 0) {
    const keys = keysOf(rec);
    // 이미 기록이 있으면 덮어쓰지 않는다(NX) — 도구로 보낸 정확한 기록이 우선.
    // 없거나 만료된 자리만 새로 잡는다 → 재동기화가 만료된 차단을 되살린다.
    const out = await pipeline(keys.map(k => ["SET", k, val, "NX", "EX", String(ttl)]));
    blocked = out.some(r => r === "OK");
  }

  // 이미 가져온 메일이면 로그는 다시 안 쌓는다 (차단키는 위에서 이미 갱신됨)
  if (seen) return { duplicate: true, blocking: blocked };

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

// 여러 회신을 한 번에 기록한다 — 중복 확인(SISMEMBER)과 기록을 각각 한 번의 파이프라인으로.
// 한 통씩 저장소를 왕복하면 수천 통 백필이 함수 제한시간을 넘긴다.
async function recordReplies(items) {
  const list = (items || []).filter(x => x && x.rec);
  if (!enabled() || !list.length) return { recorded: 0, duplicate: 0 };
  let recorded = 0, duplicate = 0;
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    const seen = await pipeline(chunk.map(x => x.id ? ["SISMEMBER", IMPORTED_KEY, "r:" + x.id] : ["ECHO", "0"]));
    const cmds = [], batchIds = new Set();
    chunk.forEach((x, j) => {
      if (x.id && (Number(seen[j]) === 1 || batchIds.has(x.id))) { duplicate++; return; }
      if (x.id) { batchIds.add(x.id); cmds.push(["SADD", IMPORTED_KEY, "r:" + x.id]); }
      cmds.push(["LPUSH", REPLY_KEY, JSON.stringify(x.rec)]);
      recorded++;
    });
    if (cmds.length) { cmds.push(["LTRIM", REPLY_KEY, "0", String(REPLY_MAX - 1)]); await pipeline(cmds); }
  }
  return { recorded, duplicate };
}

// 작은 값 하나를 그대로 읽고 쓴다 (자동 실행의 커서·마지막 상태 보관용)
async function readRaw(key) { return enabled() ? cmd(["GET", key]) : null; }
async function writeRaw(key, val) { if (enabled()) await cmd(["SET", key, String(val)]); }

// ─── 리마인드(자동 팔로업) 예약 ─────────────────────────────────
// 첫 메일에 회신이 없을 때 며칠 뒤 다시 보낼 계획을 저장한다. 담당자+크리에이터 한 쌍당
// 하나(HASH 필드)라 같은 사람에게 다시 보내면 계획이 갱신된다. 크론이 매일 훑어 처리한다.
const REMIND_KEY = "outreach:reminders";        // HASH: key → 계획 JSON
const REMIND_LOG_KEY = "outreach:reminders:log"; // 실제로 보낸 리마인드 기록 (관리자 표시용)
const REMIND_LOG_MAX = 20000;

function reminderKey(to, by) { return normEmail(to) + "|" + String(by || "").trim().toLowerCase(); }

async function scheduleReminder(plan) {
  if (!enabled()) return { skipped: true };
  const key = reminderKey(plan.to, plan.by);
  if (!normEmail(plan.to)) return { skipped: true };
  await cmd(["HSET", REMIND_KEY, key, JSON.stringify(Object.assign({ key: key }, plan))]);
  return { scheduled: true, key: key };
}

// Upstash REST 의 HGETALL 은 [field, value, field, value, …] 평면 배열로 온다.
async function allReminders() {
  if (!enabled()) return [];
  const flat = await cmd(["HGETALL", REMIND_KEY]);
  const out = [];
  if (Array.isArray(flat)) {
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const p = parseRec(flat[i + 1]);
      if (p) { p.key = p.key || flat[i]; out.push(p); }
    }
  } else if (flat && typeof flat === "object") {
    Object.keys(flat).forEach(function (k) { const p = parseRec(flat[k]); if (p) { p.key = p.key || k; out.push(p); } });
  }
  return out;
}

async function saveReminder(key, plan) { if (enabled()) await cmd(["HSET", REMIND_KEY, key, JSON.stringify(Object.assign({ key: key }, plan))]); }
async function cancelReminder(key) { if (enabled()) await cmd(["HDEL", REMIND_KEY, key]); }

async function logReminderSent(rec) {
  if (!enabled()) return;
  await pipeline([["LPUSH", REMIND_LOG_KEY, JSON.stringify(rec)], ["LTRIM", REMIND_LOG_KEY, "0", String(REMIND_LOG_MAX - 1)]]);
}
function recentReminders(n) { return readList(REMIND_LOG_KEY, REMIND_LOG_MAX, n); }

// ─── 예약 발송 ───────────────────────────────────────────────────
// 담당자가 "이 시각(크리에이터 현지 시간)에 보내 달라" 고 맡겨둔 발송 작업.
// HASH 하나에 작업 id → JSON 으로 둔다. 크론(15분 간격)이 기한이 된 것을 꺼내 보낸다.
// 캠페인 전문(스냅샷)을 그대로 저장한다 — 예약 후 화면에서 폼을 바꿔도 예약분은 안 변한다.
const SCHED_KEY = "outreach:schedule";

async function saveSchedule(job) {
  if (!enabled()) return { skipped: true };
  await cmd(["HSET", SCHED_KEY, String(job.id), JSON.stringify(job)]);
  return { saved: true };
}

async function allSchedules() {
  if (!enabled()) return [];
  const flat = await cmd(["HGETALL", SCHED_KEY]);
  const out = [];
  if (Array.isArray(flat)) {
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const p = parseRec(flat[i + 1]);
      if (p) { p.id = p.id || flat[i]; out.push(p); }
    }
  } else if (flat && typeof flat === "object") {
    Object.keys(flat).forEach(function (k) { const p = parseRec(flat[k]); if (p) { p.id = p.id || k; out.push(p); } });
  }
  return out;
}

async function deleteSchedule(id) { if (enabled()) await cmd(["HDEL", SCHED_KEY, String(id)]); }

module.exports = {
  enabled, lookup, reserve, release, log, logBlocked, importSend, readRaw, writeRaw,
  approveSend, isApproved, revokeApproval, approvalsIndex, allApprovals, approvalFieldsOf,
  recordReply, recordReplies, recent, recentBlocked, recentReplies, count,
  scheduleReminder, allReminders, saveReminder, cancelReminder, logReminderSent, recentReminders, reminderKey,
  saveSchedule, allSchedules, deleteSchedule,
  LOG_KEY, BLOCK_KEY, REPLY_KEY, REMIND_LOG_KEY,
  normEmail, normHandle, isIgnoredSender, importSends, bookSentPriors, bookOwners, bookGetMany,
  bridge, rebuildBridge, bridgeReady, addSentTo, sentToSet, bookMerge, bookAll, bookCount, saveSyncInfo, syncInfo, storeMessages, messageCount, messageUsage, messagesWith,
  WINDOW_DAYS, LOG_MAX, BLOCK_MAX, REPLY_MAX
};
