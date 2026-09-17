const {getDb}=require('../db/database');
const {createHash}=require('node:crypto');
async function record(event,productId,identity){
 if(!['checkout_opened','whatsapp_clicked'].includes(event)||!Object.hasOwn(require('../products'),productId))return;
 const db=await getDb();
 const id=createHash('sha256').update(event+':'+productId+':'+identity).digest('hex');
 await db.run('INSERT INTO conversion_events(id,product_id,event) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING',id,productId,event);
}
async function summary(){
 const db=await getDb();
 const provider=require('../payments/provider').name;
 const creating=await db.all("SELECT * FROM orders WHERE status='CREATING' AND payment_provider=? ORDER BY id LIMIT 100",provider);
 for(const order of creating)await require('./orders').recoverCreation(order);
 const reviewOrders=await db.all("SELECT public_id,product_id,amount,created_at FROM orders WHERE status='FAILED' AND creation_phase IN ('uncertain','legacy') AND payment_provider=? ORDER BY id DESC LIMIT 50",provider);

 const events=await db.all("SELECT product_id,event,COUNT(*) n FROM conversion_events WHERE created_at>=datetime('now','-30 days') GROUP BY product_id,event");
 const orders=await db.all("SELECT product_id,COUNT(*) generated,SUM(CASE WHEN status='PAID' THEN 1 ELSE 0 END) paid,SUM(CASE WHEN status='PAID' AND buyer_id IS NOT NULL THEN 1 ELSE 0 END) linked,SUM(CASE WHEN status='PAID' AND claim_required=1 AND buyer_id IS NULL THEN 1 ELSE 0 END) awaitingClaim FROM orders WHERE created_at>=datetime('now','-30 days') AND payment_provider=? AND status NOT IN ('CREATING','FAILED') GROUP BY product_id", require('../payments/provider').name);
 return {reviewOrders,days:30,mode:require('../payments/provider').name,products:Object.keys(require('../products')).map(id=>({id,opened:Number(events.find(e=>e.product_id===id&&e.event==='checkout_opened')?.n||0),generated:Number(orders.find(o=>o.product_id===id)?.generated||0),paid:Number(orders.find(o=>o.product_id===id)?.paid||0),linked:Number(orders.find(o=>o.product_id===id)?.linked||0),awaitingClaim:Number(orders.find(o=>o.product_id===id)?.awaitingClaim||orders.find(o=>o.product_id===id)?.awaitingclaim||0),whatsappClicks:Number(events.find(e=>e.product_id===id&&e.event==='whatsapp_clicked')?.n||0)}))};
}
module.exports={record,summary};
