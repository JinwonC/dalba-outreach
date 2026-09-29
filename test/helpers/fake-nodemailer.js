// 테스트용 nodemailer — 실제로 보내지 않는다. 테스트가 global.FAKE_NODEMAILER_MODULE 에
// { exports: { createTransport } } 를 넣으면 그걸 쓴다.
const dflt = () => ({ verify: async () => true, sendMail: async () => ({ messageId: "<fake@test>" }), close() {} });
module.exports = {
  createTransport: (...a) => {
    const o = global.FAKE_NODEMAILER_MODULE;
    return o && o.exports && o.exports.createTransport ? o.exports.createTransport(...a) : dflt(...a);
  }
};
