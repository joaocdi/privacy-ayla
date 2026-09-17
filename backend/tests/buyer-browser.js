require('./sqlite-env');
const assert=require('node:assert/strict'),crypto=require('crypto'),path=require('path');
process.env.DATABASE_PATH=path.resolve(__dirname,'../.test-runs/buyer-browser-'+crypto.randomUUID()+'.sqlite');
process.env.PAYMENT_PROVIDER='syncpay';process.env.FRONTEND_URL='';process.env.VIP_MEDIA_SECRET=crypto.randomBytes(32).toString('hex');
Object.assign(process.env,{SYNCPAY_CLIENT_ID:'browser-fixture',SYNCPAY_CLIENT_SECRET:'browser-fixture',SYNCPAY_WEBHOOK_SECRET:'browser-webhook'});
const realFetch=global.fetch;
global.fetch=async(url,options)=>{
 if(String(url).startsWith('http://127.0.0.1:'))return realFetch(url,options);
 assert.ok(String(url).startsWith('https://api.syncpayments.com.br/api/partner/v1/'));
 if(url.endsWith('/auth-token'))return Response.json({access_token:'browser-token',expires_in:3600});
 assert.deepEqual(JSON.parse(options.body),{amount:9.9});
 return Response.json({identifier:crypto.randomUUID(),pix_code:'fixture-pix'});
};
const {app}=require('../server'),database=require('../db/database');
const {chromium}=require('../.test-runs/browser/node_modules/playwright');let server,browser;
async function main(){
 await database.initDb();server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port,db=await database.getDb();
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 for(const width of [320,375,390,430,768,1280]){
  const context=await browser.newContext({viewport:{width,height:850},hasTouch:true,permissions:['clipboard-read','clipboard-write']});const page=await context.newPage();
  await page.goto(base+'/');await page.locator('#ageConfirm').click();await page.evaluate(()=>openCheckout('ayla_monthly'));
  const phone=page.locator('#checkoutClientForm input[name="phone"]');await phone.waitFor({state:'visible'});
  assert.equal(await page.locator('#checkoutClientForm input:enabled').count(),1);
  await page.screenshot({path:path.resolve(__dirname,'../.test-runs/buyer-phone-'+width+'.png'),animations:'disabled'});
  await phone.fill('11999990000');assert.equal(await phone.inputValue(),'(11) 99999-0000');
  await page.locator('#checkoutClientForm button').tap();await page.waitForSelector('#pixActiveArea',{state:'visible'});
  const pending=await page.evaluate(()=>AylaCheckouts.selected());
  const order=await db.get('SELECT * FROM orders WHERE public_id=?',pending.payment.orderId);
  assert.equal(order.customer_phone,'5511999990000');assert.equal(order.customer_email,null);assert.equal(order.customer_document_hash,null);
  const auth={Authorization:'Bearer '+pending.token};
  const vip=()=>context.request.get(base+'/api/vip/'+order.public_id,{headers:auth});
  assert.equal((await vip()).status(),403);
  await db.run("UPDATE orders SET status='FAILED' WHERE id=?",order.id);assert.equal((await vip()).status(),403);
  await db.run("UPDATE orders SET status='PAID' WHERE id=?",order.id);assert.equal((await vip()).status(),403);
  await db.run("UPDATE orders SET status='PENDING' WHERE id=?",order.id);
  await page.reload();await page.waitForSelector('#pixActiveArea',{state:'visible'});
  assert.equal(await phone.isVisible(),false,'refresh resumes without another phone prompt');
  const qr=page.locator('#pixQrImage');await qr.evaluate(img=>img.decode());assert.ok((await qr.boundingBox()).width>=180);
  const copy=page.locator('#btnCopyPix');assert.ok((await copy.boundingBox()).height>=44);
  await copy.tap();await page.waitForFunction(()=>document.getElementById('btnCopyPix').textContent.includes('Copiado'));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.resolve(__dirname,'../.test-runs/buyer-pix-'+width+'.png')});
  const raw=JSON.stringify({event:'transaction.updated',event_id:crypto.randomUUID(),transaction:{reference_id:order.provider_payment_id,status:'completed',amount:9.9,currency:'BRL',payment_method:'pix'}}),t=Math.floor(Date.now()/1000);
  const signature=crypto.createHmac('sha256',process.env.SYNCPAY_WEBHOOK_SECRET).update(t+'.'+raw).digest('hex');
  const paid=await context.request.post(base+'/api/webhooks/syncpay',{headers:{'Content-Type':'application/json','X-SyncPay-Event':'transaction.updated','X-SyncPay-Delivery':crypto.randomUUID(),'X-SyncPay-Signature':'t='+t+',v1='+signature},data:raw});assert.equal(paid.status(),200);
  await page.waitForURL('**/vip');await page.waitForSelector('#vipContent',{state:'visible'});assert.equal((await vip()).status(),200);
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('ayla.vip.access')));assert.equal(saved.orderId,order.public_id);
  await page.goto(base+'/');await page.locator('[data-buyer-access]').first().tap();await page.locator('#savedVipLink').tap();await page.waitForURL('**/vip');await page.waitForSelector('#vipContent',{state:'visible'});
  await page.reload();await page.waitForSelector('#vipContent',{state:'visible'});
  const stranger=await browser.newContext({viewport:{width,height:850}});const other=await stranger.newPage();await other.goto(base+'/vip');await other.waitForSelector('#vipBlocked',{state:'visible'});
  assert.equal((await stranger.request.get(base+'/api/vip/'+order.public_id+'?phone=11999990000')).status(),403);
  await other.goto(base+'/?recover=1');await other.locator('#ageConfirm').click();await other.locator('#buyerRecoveryPhone input').fill('11999990000');await other.locator('#buyerRecoveryPhone button').click();
  await other.waitForFunction(()=>document.getElementById('buyerRecoveryStatus').textContent.includes('indisponível'));
  assert.equal(await other.locator('#buyerRecoveryCode').isVisible(),false);
  assert.ok(await other.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await db.run("UPDATE entitlements SET status='EXPIRED' WHERE order_id=?",order.id);assert.equal((await vip()).status(),403);
  console.log('PASS buyer mobile '+width+': simulated SyncPay, phone-only, QR/copy, signed webhook, automatic VIP, saved access, stranger/phone denied, expiry, unavailable recovery');
  await stranger.close();await context.close();
 }
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await database.closeDb();});

