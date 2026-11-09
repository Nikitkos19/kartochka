import assert from 'node:assert/strict';
import { moderationPolicy,moderationPolicyVersion,validateModerationDecision,moderateProductImage,policyVersion,isApprovedPolicyVersion,redactModerationEvidence,moderationError } from './product-moderation.mjs';
const decision=(state='ALLOW',category)=>({decision:state,categories:category?[category]:[],items:[{input_id:'image_1',decision:state,categories:category?[category]:[],evidence:'Test fixture'},{input_id:'request',decision:'ALLOW',categories:[],evidence:'Image request'}],reason:'Test fixture',user_message:'Test fixture'});
assert.match(moderationPolicyVersion,/^product-v1-/);
assert.ok(!moderationPolicy.includes('LGBT_THEME'));
assert.ok(moderationPolicy.includes('OFF_TOPIC')&&moderationPolicy.includes('ROLE_OVERRIDE'));
assert.equal(validateModerationDecision(decision()).decision,'ALLOW');
for(const invalid of [null,{}, {...decision(),extra:true},{...decision(),decision:'allow'},{...decision(),categories:['WEAPONS']},{...decision(),items:[decision().items[0],decision().items[0]]},decision('REJECT','UNKNOWN'),{...decision('REJECT','WEAPONS'),decision:'ALLOW'}, {...decision(),items:[]}])assert.throws(()=>validateModerationDecision(invalid),/недоступна/);
const examples=[...moderationPolicy.matchAll(/\{\n  "decision"[\s\S]*?\n\}/g)].map(m=>JSON.parse(m[0]));
assert.deepEqual(examples.map(value=>validateModerationDecision(value).decision),['ALLOW','REJECT','REVIEW']);
assert.equal(policyVersion(moderationPolicy),policyVersion(moderationPolicy.replace(/\n/g,'\r\n')));
for(const version of ['product-v1-ae67d6ff5847','product-v1-dfd5fd26b3fa',moderationPolicyVersion])assert.equal(isApprovedPolicyVersion(version),true);
for(const version of ['',null,'product-v1-unknown'])assert.equal(isApprovedPolicyVersion(version),false);
const rejected=validateModerationDecision({...decision('REJECT','WEAPONS'),reason:'Email owner@example.invalid; key sk-not-a-real-key-1234567890; card 4111 1111 1111 1111'});
assert.ok(!rejected.reason.includes('owner@')&&!rejected.reason.includes('4111')&&!rejected.reason.includes('sk-'));
assert.ok(redactModerationEvidence('https://fixture.invalid/private').includes('[link]'));
assert.equal(redactModerationEvidence('password=fixture-secret пароль:секрет api_key=fixture-value токен:fixture-value'),'password=[secret] пароль:[secret] api_key=[secret] токен:[secret]');
const privacy=decision('REJECT','FRAUD_PRIVACY');privacy.reason='Private identity fixture';privacy.items[0].evidence='Private identity fixture';
const privateResult=validateModerationDecision(privacy);assert.ok(!JSON.stringify(privateResult).includes('Private identity fixture'));

assert.notEqual(moderationError(decision('REJECT','WEAPONS'),'input').message,moderationError(decision('REJECT','DRUGS'),'input').message);
assert.equal(moderationError(decision('REJECT','WEAPONS'),'output').moderation.stage,'output');
const nativeFetch=globalThis.fetch;
const body={name:'Chair',sku:'chair',page:'main',style:'natural',color:'#ffffff',features:{},customPrompt:'Soft light'};
const cfg={base:'http://fixture.invalid',apiKey:'test',model:'vision-test',timeoutMs:100};
const audits=[];
try{
 globalThis.fetch=async(url,options)=>{assert.equal(url,'http://fixture.invalid/chat/completions');const r=JSON.parse(options.body);assert.equal(r.messages[0].role,'system');assert.equal(r.messages[0].content,moderationPolicy);assert.equal(r.messages[1].content.at(-1).image_url.url,'data:image/png;base64,dGVzdA==');assert.ok(!Object.hasOwn(r,'response_format'));return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(decision())}}]}));};
 await moderateProductImage(body,'data:image/png;base64,dGVzdA==','input',cfg,x=>audits.push(x));
 assert.equal(audits.at(-1).decision,'ALLOW');assert.equal(audits.at(-1).reason,'Test fixture');assert.equal(audits.at(-1).details.length,2);
 for(const state of ['REJECT','REVIEW']){
  globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(decision(state,'WEAPONS'))}}]}));
  await assert.rejects(()=>moderateProductImage(body,'image','input',cfg,x=>audits.push(x)),e=>e.status===422&&e.moderationCode==='MODERATION_'+state);
 }
 for(const envelope of [{choices:[{finish_reason:'length',message:{content:JSON.stringify(decision())}}]},{choices:[{finish_reason:'stop',message:{content:'```json\n{}\n```'}}]},{}]){
  globalThis.fetch=async()=>new Response(JSON.stringify(envelope));
  await assert.rejects(()=>moderateProductImage(body,'image','output',cfg,x=>audits.push(x)),e=>e.status===503);
  assert.equal(audits.at(-1).decision,'ERROR');
 }
 globalThis.fetch=async()=>{throw Error('Network failure secret-placeholder')};
 await assert.rejects(()=>moderateProductImage(body,'image','input',cfg,x=>audits.push(x)),e=>e.status===503&&!e.message.includes('secret-placeholder'));
 assert.ok(audits.every(x=>!Object.hasOwn(x,'image')&&!Object.hasOwn(x,'email')&&!Object.hasOwn(x,'prompt')));
}finally{globalThis.fetch=nativeFetch}
console.log('PASS: strict moderation schema, per-image/request aggregation, ALLOW-only processing, REJECT/REVIEW/errors fail closed, server policy separated from input, safe audit metadata.');
