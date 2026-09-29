// 테스트: 회신 온 인원 — 담당자 필터가 메일함 주인 기준인지
require("./helpers/stubs");
process.env.NW_ACCOUNTS = JSON.stringify([
  { id:"jinwon", pw:"x", appPassword:"y", email:"jinwon.choi@dalba.com", name:"Jinwon (admin)" },
  { id:"luna", pw:"x", appPassword:"y", email:"luna@dalbausa.com", name:"Luna" },
  { id:"seoyeon", pw:"x", appPassword:"y", email:"seoyeon@dalba.com", name:"Seoyeon" }
]);
process.env.ADMIN_EMAILS = "jinwon.choi@dalba.com";
process.env.KV_REST_API_URL = "https://stub.local";
process.env.KV_REST_API_TOKEN = "stub";
const A = require("../auth.js");
const H = require("../history.js");
const now = new Date().toISOString();
const sent = [
  { to:"cA@x.com", handle:"@a", by:"seoyeon@dalba.com", byName:"Seoyeon", at:now },
  { to:"cB@x.com", handle:"@b", by:"luna@dalbausa.com", byName:"Luna", at:now },
  { to:"cC@x.com", handle:"@c", by:"jinwon.choi@dalba.com", byName:"Jinwon (admin)", at:now },
];
const replies = [
  // cA replied to seoyeon's inbox (but OLD record wrongly says by=luna)
  { from:"cA@x.com", fromName:"CA", at:now, subject:"re a", inbox:"seoyeon@dalba.com", by:"luna@dalbausa.com", byName:"Luna" },
  // cB replied to luna's inbox
  { from:"cB@x.com", fromName:"CB", at:now, subject:"re b", inbox:"luna@dalbausa.com", by:"luna@dalbausa.com", byName:"Luna" },
  // cC replied to admin jinwon's inbox
  { from:"cC@x.com", fromName:"CC", at:now, subject:"re c", inbox:"jinwon.choi@dalba.com", by:"jinwon.choi@dalba.com", byName:"Jinwon (admin)" },
];
H.enabled=()=>true; H.recent=async()=>sent.slice(); H.recentBlocked=async()=>[];
H.recentReplies=async()=>replies.slice(); H.recentReminders=async()=>[]; H.count=async()=>3;
H.approvalsIndex=async()=>new Set(); H.allApprovals=async()=>[];
const admin = require("../api/admin.js");
A.currentUser=()=>({email:"jinwon.choi@dalba.com",name:"Jinwon (admin)"});
function run(query){return new Promise(res=>{const req={method:"GET",query,headers:{}};const r={_s:0,setHeader(){},status(s){this._s=s;return this;},json(o){res({status:this._s,body:o});}};admin(req,r);});}
(async()=>{
  let ok=0,bad=0; const ck=(c,m)=>{if(c)ok++;else{bad++;console.log("FAIL:",m);}};
  const emails = d => (d.body.rows||[]).map(r=>String(r.email).toLowerCase());

  const all = await run({view:"repliers"});
  ck(all.status===200 && emails(all).length===3, "전체: 3명 (관리자 포함)");

  const seo = await run({view:"repliers", by:"seoyeon@dalba.com"});
  ck(emails(seo).length===1 && emails(seo).includes("ca@x.com"), "seoyeon 선택 → cA 만 (서연 발송분 회신)");
  ck(!emails(seo).includes("cb@x.com"), "seoyeon 선택 → luna 회신 cB 안 나옴");

  const luna = await run({view:"repliers", by:"luna@dalbausa.com"});
  ck(emails(luna).length===1 && emails(luna).includes("cb@x.com"), "luna 선택 → cB 만 (cA 는 서연 메일함이라 제외)");

  const adm = await run({view:"repliers", by:"jinwon.choi@dalba.com"});
  ck(emails(adm).length===1 && emails(adm).includes("cc@x.com"), "관리자(jinwon) 선택 → cC (관리자도 필터 동작)");

  console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad?1:0);
})();
