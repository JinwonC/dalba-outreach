// 테스트용 mailparser — 원문 전체를 text 로 돌려준다.
module.exports = { simpleParser: async (src) => ({ text: String(src || "") }) };
