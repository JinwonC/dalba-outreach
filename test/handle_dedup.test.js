// 테스트: 핸들만으로도 중복 차단되는지
require("./helpers/stubs");
// Prove dedup blocks by HANDLE (not just email), and pin down the real coverage gap.
process.env.KV_REST_API_URL = "https://stub.local";
process.env.KV_REST_API_TOKEN = "stub";

const store = new Map();
function run1(a) {
  const op = String(a[0]).toUpperCase();
  if (op === "SET") {
    const k = a[1], v = a[2];
    const nx = a.includes("NX");
    if (nx && store.has(k)) return null;
    store.set(k, v); return "OK";
  }
  if (op === "GET") return store.has(a[1]) ? store.get(a[1]) : null;
  if (op === "MGET") return a.slice(1).map(x => store.has(x) ? store.get(x) : null);
  if (op === "HMGET") return a.slice(2).map(() => null);
  if (op === "DEL") { const had = store.delete(a[1]); return had ? 1 : 0; }
  if (op === "HGET") return null;
  if (op === "HGETALL") return [];
  return null;
}
global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  if (String(url).endsWith("/pipeline")) {
    return { json: async () => body.map(cmd => ({ result: run1(cmd) })) };
  }
  return { json: async () => ({ result: run1(body) }) };
};

const H = require("../history.js");

(async () => {
  let ok = 0, bad = 0; const ck = (c, m) => { if (c) ok++; else { bad++; console.log("FAIL:", m); } };

  // seoyeon sends to handle @foo / email a@x.com
  const r1 = await H.reserve({ to: "a@x.com", handle: "@foo", creatorName: "Foo" }, { by: "seoyeon@dalba.com", byName: "Seoyeon" }, false);
  ck(r1.ok === true, "first send reserved ok");

  // luna tries the SAME HANDLE but a DIFFERENT email -> must be blocked by handle
  const r2 = await H.reserve({ to: "different@y.com", handle: "@foo", creatorName: "Foo" }, { by: "luna@dalbausa.com", byName: "Luna" }, false);
  ck(r2.ok === false, "same HANDLE, different email -> BLOCKED (handle dedup works)");
  ck(r2.prior && String(r2.prior.by).includes("seoyeon"), "block cites seoyeon as prior");

  // luna tries the SAME EMAIL but no handle -> blocked by email
  const r3 = await H.reserve({ to: "a@x.com", handle: "" }, { by: "luna@dalbausa.com" }, false);
  ck(r3.ok === false, "same EMAIL -> BLOCKED (email dedup works)");

  // lookup by handle only finds it
  const [byHandle] = await H.lookup([{ handle: "@foo" }]);
  ck(byHandle && String(byHandle.by).includes("seoyeon"), "lookup by HANDLE only -> found");

  // lookup by email only finds it
  const [byEmail] = await H.lookup([{ to: "a@x.com" }]);
  ck(byEmail && String(byEmail.by).includes("seoyeon"), "lookup by EMAIL only -> found");

  // THE GAP: a creator contacted with NO handle recorded (email-only, e.g. IMAP import) ...
  await H.reserve({ to: "noh@z.com", handle: "" }, { by: "seoyeon@dalba.com" }, false);
  // ... checking that creator BY HANDLE cannot match (there is no handle key to hit)
  const [gap] = await H.lookup([{ handle: "@nohandle" }]);
  ck(gap === null, "email-only contact is INVISIBLE to a handle check (the coverage gap)");

  console.log(`\n${ok} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
