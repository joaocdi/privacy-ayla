require('./sqlite-env');
const assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path');
Object.assign(process.env,{BUYER_ACCOUNT_FLOW:'true',PAYMENT_PROVIDER:'syncpay',SYNCPAY_CLIENT_ID:'fixture',SYNCPAY_CLIENT_SECRET:'fixture',SYNCPAY_WEBHOOK_SECRET:'fixture',SUPABASE_URL:'https://auth.invalid',SUPABASE_ANON_KEY:'fixture',SUPABASE_SERVICE_ROLE_KEY:'fixture-service',WHATSAPP_NUMBER:'5548999990000',DATABASE_PATH:path.resolve(__dirname,'../.test-runs/accounts-'+crypto.randomUUID()+'.sqlite')});
let identity='buyer1',authCalls=0,server;const original=global.fetch;
global.fetch=async(url,options)=>{
 if(String(url).startsWith('http://127.0.0.1:'))return original(url,options);
 if(String(url).startsWith('https://auth.invalid')){authCalls++;return Response.json(url.endsWith('/user')?{id:identity,email:identity+'@example.test'}:{access_token:'fixture',user:{id:identity,email:identity+'@example.test'}});}
 assert.ok(String(url).startsWith('https://api.syncpayments.com.br/api/partner/v1/'));
 if(url.endsWith('/auth-token'))return Response.json({access_token:'fixture',expires_in:3600});
 assert.deepEqual(Object.keys(JSON.parse(options.body)),['amount']);return Response.json({identifier:crypto.randomUUID(),pix_code:'fixture'});
};
const {app}=require('../server'),database=require('../db/database'),{confirmPayment}=require('../services/entitlements');
(async()=>{
 await database.initDb();server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;process.env.PUBLIC_APP_URL=base;const db=await database.getDb();
 async function req(route,body,cookie='',token=''){const r=await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Origin:base,Cookie:cookie,Authorization:'Bearer '+token},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json().catch(()=>({})),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const token=crypto.randomBytes(32).toString('hex'),created=await req('/api/payments/pix',{productId:'ayla_monthly',checkoutToken:token});assert.equal(created.status,201);
 const id=created.data.orderId;let order=await db.get('SELECT * FROM orders WHERE public_id=?',id);assert.equal(order.buyer_id,null);assert.equal(order.customer_phone,null);assert.equal(order.customer_email,null);assert.notEqual(order.claim_token_hash,token);
 const body={orderId:id,claimToken:token,email:'buyer1@example.test',phone:'11999990000',password:'test-password',confirmPassword:'test-password'};
 assert.equal((await req('/api/buyer/account/register',body)).status,403);assert.equal(authCalls,0);
 await confirmPayment(id);await confirmPayment(id);assert.equal((await db.get('SELECT COUNT(*) n FROM entitlements')).n,0);
 assert.equal((await req('/api/vip/'+id,null,'',token)).status,403);
 assert.equal((await req('/api/buyer/account/register',{...body,claimToken:'0'.repeat(64)})).status,403);
 const registered=await req('/api/buyer/account/register',body);assert.equal(registered.status,200);assert.ok(registered.cookie);const cookie=registered.cookie;
 assert.equal((await db.get('SELECT COUNT(*) n FROM entitlements')).n,1);assert.equal((await req('/api/vip/'+id,null,cookie)).status,200);
 assert.equal((await req('/api/vip/'+id,null,'',token)).status,403);
 assert.equal((await req('/api/buyer/account/claim',{orderId:id,claimToken:token},cookie)).status,200);
 assert.equal((await req('/api/buyer/account/claim',{orderId:id,claimToken:token})).status,401);
 await db.run("INSERT INTO buyer_accounts(user_id,email,phone) VALUES ('buyer2','buyer2@example.test','5511999990000')");identity='buyer2';const other=await req('/api/buyer/account/login',{email:'buyer2@example.test',password:'test-password'});
 assert.equal((await req('/api/buyer/account/claim',{orderId:id,claimToken:token},other.cookie)).status,403);
 assert.equal((await req('/api/vip/'+id,null,other.cookie)).status,403);
 for(const productId of ['ayla_quarterly','ayla_semester','ayla_whatsapp_unlock']){const t=crypto.randomBytes(32).toString('hex');const p=await req('/api/payments/pix',{productId,checkoutToken:t},cookie);assert.equal(p.status,201);const row=await db.get('SELECT * FROM orders WHERE public_id=?',p.data.orderId);assert.equal(row.buyer_id,null);assert.equal(row.purchase_buyer_id,'buyer1');await confirmPayment(p.data.orderId);await confirmPayment(p.data.orderId);const grant=await db.get('SELECT * FROM entitlements WHERE order_id=?',row.id);assert.equal(grant.grant_type,productId==='ayla_whatsapp_unlock'?'contact':'subscription');if(productId==='ayla_whatsapp_unlock'){assert.equal(grant.expires_at,null);assert.equal((await req('/api/vip/'+p.data.orderId,null,cookie)).status,403);}else assert.ok(grant.expires_at);}
 assert.equal((await req('/api/buyer/account',null,cookie)).data.orders.length,4);
 assert.equal((await db.get('SELECT COUNT(*) n FROM entitlements')).n,4);
 assert.equal((await req('/api/admin/me',null,cookie)).data.admin,false);
 const evil=await fetch(base+'/api/buyer/account/logout',{method:'POST',headers:{Origin:'https://evil.invalid','Content-Type':'application/json',Cookie:cookie},body:'{}'});assert.equal(evil.status,403);
 identity='buyer1';
 const login=await req('/api/buyer/account/login',{email:'buyer1@example.test',password:'test-password'});assert.equal(login.status,200);
 assert.equal((await req('/api/buyer/account/recover',{email:'buyer1@example.test'})).status,200);
 assert.equal((await req('/api/buyer/account/reset',{password:'replacement-password',confirmPassword:'replacement-password',accessToken:'fixture'})).status,200);
 assert.equal((await req('/api/buyer/account',null,login.cookie)).status,401);
 await req('/api/buyer/account/logout',{},cookie);assert.equal((await req('/api/buyer/account',null,cookie)).status,401);
 for(const route of ['/backend/server.js','/backend/.env','/backend/tests/buyer-accounts.js','/.env','/backend/scripts/test-syncpay-minimal.js'])assert.equal((await req(route)).status,404);
 console.log('PASS account flow: no prepayment PII, hashed claim, pending/forged/consumed/foreign claim denied, paid alone grants nothing, Supabase signup, account cookie, legacy token denied, four products, logged buyer purchases, unique grants, admin isolation, logout and private files');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{global.fetch=original;if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await database.closeDb();});
