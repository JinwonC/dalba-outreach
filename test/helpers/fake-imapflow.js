// shared fake IMAP server for tests — reads global.FAKE, records fetch queries in global.FETCH_QUERIES
class ImapFlow {
  constructor(opts) { this.opts = opts; this.mailbox = null; this.cur = null; }
  async connect() {} async logout() {} close() {}
  async list() { return global.FAKE.boxes.map(b => Object.assign({ delimiter: "/" }, b)); }
  async getMailboxLock(path) { const l = global.FAKE.msgs[path]; if (!l) throw new Error("no box " + path); this.cur = path; this.mailbox = { exists: l.length }; return { release() {} }; }
  async search(c) { const l = global.FAKE.msgs[this.cur] || []; return l.filter(m => (!c.since || new Date(m.date) >= c.since) && (!c.from || String(m.from || "").toLowerCase().includes(String(c.from).toLowerCase())) && (!c.subject || String(m.subject || "").toLowerCase().includes(String(c.subject).toLowerCase())) && (!c.to || (m.to || []).includes(c.to))).map(m => m.uid); }
  async *fetch(range, q) {
    const l = global.FAKE.msgs[this.cur] || [];
    global.FETCH_QUERIES = (global.FETCH_QUERIES || []).concat([q]);
    const pick = Array.isArray(range) ? l.filter(m => range.includes(m.uid)) : l.slice(Number(String(range).split(":")[0]) - 1);
    for (const m of pick) yield { uid: m.uid, envelope: { messageId: m.id, date: m.date, subject: m.subject, from: [{ address: m.from, name: "" }], to: (m.to || []).map(x => ({ address: x })), cc: [], bcc: (m.bcc || []).map(x => ({ address: x })) }, source: q && q.source ? Buffer.from(m.body || "") : undefined };
  }
}
module.exports = { ImapFlow };
