// 테스트 전용: 외부 메일 모듈을 가짜로 바꿔 끼운다 (실제 IMAP·SMTP 서버에 붙지 않게).
//   imapflow   → helpers/fake-imapflow.js (global.FAKE 에 적힌 폴더·메일을 돌려준다)
//   mailparser → 원문을 그대로 본문으로 돌려주는 최소 구현
//   nodemailer → 보내는 척만 한다. global.FAKE_NODEMAILER_MODULE 로 테스트마다 바꿀 수 있다.
// 테스트 파일 맨 첫 줄에서 require 한다 — 앱 모듈보다 먼저 걸려 있어야 한다.
const Module = require("module");
const path = require("path");
const MAP = {
  imapflow: path.join(__dirname, "fake-imapflow.js"),
  mailparser: path.join(__dirname, "fake-mailparser.js"),
  nodemailer: path.join(__dirname, "fake-nodemailer.js")
};
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (Object.prototype.hasOwnProperty.call(MAP, request)) return MAP[request];
  return orig.call(this, request, parent, ...rest);
};
