const assert=require('node:assert/strict');
const {diagnose}=require('../scripts/test-sigilopay-minimal');
(async()=>{
 const calls=[],config={endpoint:'https://example.invalid/pix',callbackUrl:'https://example.invalid/api/payments/webhook',amount:9.9,client:{name:'Isolated test',email:'test@example.invalid',phone:'11999990000'},publicKey:'test-public',secretKey:'test-secret'};
 const transport=async(url,options)=>{calls.push(JSON.parse(options.body));return {ok:false,status:422,text:async()=>JSON.stringify({message:'Required document.'})};};
 const rows=await diagnose(config,transport,()=>{},{all:true});
 assert.equal(rows.length,4);assert.deepEqual(calls.map(x=>Object.keys(x.client||{})),[['name','email','phone'],['name','phone'],['phone'],[]]);
 assert.ok(calls.every(x=>!Object.hasOwn(x.client||{},'document')));assert.ok(!Object.hasOwn(calls[3],'client'));
 assert.equal(new Set(calls.map(x=>x.identifier)).size,4);
 calls.length=0;await diagnose(config,transport,()=>{});assert.equal(calls.length,1,'default progressive mode preserved');
 let tries=0;await diagnose(config,async()=>{tries++;throw Error('transport');},()=>{},{all:true});assert.equal(tries,1,'uncertain request must never retry');
 console.log('PASS isolated diagnostic: all four payloads, no document, progressive default, no retry on uncertainty; zero real network');
})().catch(e=>{console.error(e);process.exitCode=1});
