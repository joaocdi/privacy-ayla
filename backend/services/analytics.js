// First-party funnel events. No PIX, passwords, contacts or private content here.
const crypto=require('node:crypto');
const {getDb}=require('../db/database');
const products=require('../products');
const EVENTS=new Set(['page_view','age_gate_confirm','plan_selected','subscription_cta_click','checkout_started','pix_generated','pix_copied','pix_qr_viewed','pix_pending_return','pix_expired','pix_regenerated','payment_confirmed','whatsapp_click','tip_started','tip_paid']);
const CLIENT=new Set(['page_view','age_gate_confirm','plan_selected','subscription_cta_click','checkout_started','pix_copied','pix_qr_viewed','pix_pending_return','pix_expired','pix_regenerated','tip_started']);
const creator=process.env.CREATOR_SLUG||require('../vip-content').profile.name.toLowerCase();
async function write(event,sessionId,productId=null,orderId=null,page='/'){
 if(!EVENTS.has(event))throw Object.assign(new Error('Evento inválido.'),{status:400});
 if(sessionId!=null&&!/^[a-f0-9]{32}$/.test(sessionId))throw Object.assign(new Error('Sessão inválida.'),{status:400});
 if(productId!=null&&!Object.hasOwn(products,productId))throw Object.assign(new Error('Produto inválido.'),{status:400});
 if(orderId!=null&&!/^ord_[a-f0-9]{48}$/.test(orderId))throw Object.assign(new Error('Pedido inválido.'),{status:400});
 if(typeof page!=='string'||!/^\/[a-z0-9/_-]*$/.test(page)||page.length>80)page='/';
 await (await getDb()).run('INSERT INTO analytics_events(id,creator,event_name,session_id,order_id,product_id,page) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',(sessionId===null&&orderId?crypto.createHash('sha256').update(creator+':'+event+':'+orderId).digest('hex'):crypto.randomUUID()),creator,event,sessionId,orderId,productId,page);
}
async function client(req){
 const body=req.body||{};
 if(Buffer.byteLength(JSON.stringify(body))>500||body.creator!==creator||!CLIENT.has(body.event_name))throw Object.assign(new Error('Evento inválido.'),{status:400});
 if(body.order_id){const order=await (await getDb()).get('SELECT product_id FROM orders WHERE public_id=?',body.order_id);if(!order||order.product_id!==body.product_id)throw Object.assign(new Error('Pedido desconhecido.'),{status:400});}
 return write(body.event_name,body.session_id,body.product_id??null,body.order_id??null,body.page||'/');
}
async function funnel(days){
 const sinceDate=days===1?(()=>{const now=new Date(),parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));const zone=new Intl.DateTimeFormat('en-US',{timeZone:'America/Sao_Paulo',timeZoneName:'shortOffset'}).formatToParts(now).find(p=>p.type==='timeZoneName')?.value||'GMT-3',hours=Number(zone.match(/GMT([+-]\d+)/)?.[1]||-3);return new Date(Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day))-hours*3600000);})():new Date(Date.now()-days*86400000);
 const since=sinceDate.toISOString().slice(0,19).replace('T',' '),db=await getDb();
 const rows=await db.all('SELECT event_name,COUNT(*) n,COUNT(DISTINCT session_id) people FROM analytics_events WHERE creator=? AND created_at>=? GROUP BY event_name',creator,since);
 const effectiveStatus="CASE WHEN status='PENDING' AND expires_at IS NOT NULL AND expires_at<=CURRENT_TIMESTAMP THEN 'EXPIRED' ELSE status END";
 const orders=await db.all(`SELECT product_id,${effectiveStatus} status,COUNT(*) n FROM orders WHERE created_at>=? AND status NOT IN ('CREATING','FAILED') GROUP BY product_id,${effectiveStatus}`,since);
 const value=name=>Number(rows.find(r=>r.event_name===name)?.people||0);
 const generated=orders.reduce((n,r)=>n+Number(r.n),0),paid=orders.filter(r=>r.status==='PAID').reduce((n,r)=>n+Number(r.n),0),expired=orders.filter(r=>r.status==='EXPIRED').reduce((n,r)=>n+Number(r.n),0);
 const visits=value('page_view'),cta=value('subscription_cta_click'),pix=generated;
 return {creator,days,visits,ageConfirmed:value('age_gate_confirm'),ctaClicks:cta,planSelected:value('plan_selected'),pixGenerated:generated,pixPaid:paid,pixExpired:expired,rates:{visitToCta:visits?cta/visits:0,ctaToPix:cta?pix/cta:0,pixToPaid:pix?paid/pix:0},products:Object.values(products).map(p=>({id:p.id,name:p.name,generated:orders.filter(r=>r.product_id===p.id).reduce((n,r)=>n+Number(r.n),0),paid:orders.filter(r=>r.product_id===p.id&&r.status==='PAID').reduce((n,r)=>n+Number(r.n),0)})),events:Object.fromEntries(rows.map(r=>[r.event_name,Number(r.n)]))};
}
module.exports={write,client,funnel,creator};
