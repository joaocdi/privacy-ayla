require('./sqlite-env');
const assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path');
process.env.DATABASE_PATH=path.resolve(__dirname,'../.test-runs/contact-'+crypto.randomUUID()+'.sqlite');
process.env.PAYMENT_PROVIDER='mock';
const {app}=require('../server'),database=require('../db/database');
let server;
(async()=>{
 await database.initDb();server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port;
 const token=crypto.randomBytes(32).toString('hex');
 async function req(route,body,secret=token){const r=await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Authorization:'Bearer '+secret},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json().catch(()=>({}))};}
 const payload={productId:'ayla_whatsapp_unlock',checkoutToken:token,client:{phone:'11999990000'},amount:0.01};
 assert.equal((await req('/api/payments/pix',payload)).status,409);
 process.env.WHATSAPP_NUMBER='5548999990000'; // isolated fixture, never contacted
 assert.equal((await req('/api/contact')).data.whatsapp,null);
 await req('/api/conversions/checkout',{productId:'ayla_whatsapp_unlock',checkoutToken:token});
 await req('/api/conversions/checkout',{productId:'ayla_whatsapp_unlock',checkoutToken:token});
 const pix=await req('/api/payments/pix',payload);assert.equal(pix.status,201);assert.equal(pix.data.product.price,7.9);
 const id=pix.data.orderId;
 assert.equal((await req('/api/contact/'+id)).status,403);
 assert.equal((await req('/api/orders/'+id+'/status')).data.contactGranted,false);
 const grants=require('../services/entitlements');
 for(let i=0;i<3;i++)await grants.confirmPayment(id);
 assert.equal((await req('/api/contact/'+id,undefined,'0'.repeat(64))).status,403);
 assert.equal((await req('/api/contact/'+id)).data.whatsapp,'https://wa.me/5548999990000');
 const funnel=(await require('../services/conversions').summary()).products.find(item=>item.id==='ayla_whatsapp_unlock');
 assert.deepEqual({opened:funnel.opened,generated:funnel.generated,paid:funnel.paid,whatsappClicks:funnel.whatsappClicks},{opened:1,generated:1,paid:1,whatsappClicks:1});
 const status=(await req('/api/orders/'+id+'/status')).data;assert.equal(status.contactGranted,true);assert.equal(status.granted,false);
 assert.equal((await req('/api/vip/'+id)).status,403);
 const db=await database.getDb();const row=await db.get('SELECT id FROM orders WHERE public_id=?',id);
 assert.equal((await db.get('SELECT COUNT(*) n FROM entitlements WHERE order_id=?',row.id)).n,1);
 await db.run("UPDATE entitlements SET status='EXPIRED' WHERE order_id=?",row.id);
 assert.equal((await req('/api/contact/'+id)).status,403);
 console.log('PASS contact: private destination, price authority, paid contact only, VIP isolation, idempotent funnel and revoked grant');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(server)await new Promise(r=>server.close(r));await database.closeDb()});
