const crypto=require('crypto');
const {getDb,transaction}=require('../db/database');
const {hash,matches}=require('./security');
const normalize=require('./buyer-phone');
const unavailable=require('./otp-provider');
const fail=(text,status=400)=>Object.assign(new Error(text),{status});
const generic='Código inválido ou expirado. Solicite um novo código.';
function digest(id,code){
 const secret=process.env.VIP_MEDIA_SECRET;
 if(!secret || secret.length<32) throw fail('Recuperação indisponível.',503);
 return crypto.createHmac('sha256',secret).update(id+':'+code).digest('hex');
}
async function limit(db,key,max,windowMs){
 const id=hash(key),now=Date.now();
 await db.run('INSERT INTO buyer_recovery_limits(id,hits,reset_at) VALUES (?,0,?) ON CONFLICT(id) DO NOTHING',id,now+windowMs);
 await db.run('UPDATE buyer_recovery_limits SET hits=CASE WHEN reset_at<=? THEN 1 ELSE hits+1 END, reset_at=CASE WHEN reset_at<=? THEN ? ELSE reset_at END WHERE id=?',now,now,now+windowMs,id);
 return Number((await db.get('SELECT hits FROM buyer_recovery_limits WHERE id=?',id)).hits)<=max;
}
// Injectable delivery adapter for isolated tests; production uses the unavailable adapter.
function create(provider=unavailable){return {
 async request(rawPhone,ip){
  if(!provider.available) return provider.send();
  const phone=normalize(rawPhone);if(!phone) throw fail('Informe um celular com DDD.');
  const id=crypto.randomBytes(24).toString('hex'),code=String(crypto.randomInt(0,1000000)).padStart(6,'0'),codeHash=digest(id,code);
  const allowed=await transaction(async db=>{
   const a=await limit(db,'send-ip:'+ip,10,900000),b=await limit(db,'send-phone:'+phone,3,900000);
   if(!a||!b)return false;
   await db.run('DELETE FROM buyer_recovery WHERE expires_at<?',Date.now()-86400000);
   await db.run('INSERT INTO buyer_recovery(id,phone,code_hash,expires_at) VALUES (?,?,?,?)',id,phone,codeHash,Date.now()+300000);
   return true;
  });
  if(!allowed)throw fail('Aguarde alguns minutos antes de tentar novamente.',429);
  try{await provider.send({phone,code});}catch(_){await (await getDb()).run('UPDATE buyer_recovery SET used=1 WHERE id=?',id);throw fail('Não foi possível enviar o código. Tente mais tarde.',503);}
  return {challenge:id,message:'Confira o código enviado ao seu celular.'};
 },
 async verify(id,code,ip){
  if(!provider.available)throw fail('Recuperação por código ainda indisponível.',503);
  if(typeof id!=='string'||!/^[a-f0-9]{48}$/.test(id)||typeof code!=='string'||!/^\d{6}$/.test(code))throw fail(generic);
  const result=await transaction(async db=>{
   if(!await limit(db,'verify-ip:'+ip,30,900000))return {error:429};
   const updated=await db.run('UPDATE buyer_recovery SET attempts=attempts+1 WHERE id=? AND used=0 AND expires_at>? AND attempts<5',id,Date.now());
   if(!updated.changes)return {error:400};
   const row=await db.get('SELECT * FROM buyer_recovery WHERE id=?',id);
   if(!crypto.timingSafeEqual(Buffer.from(digest(id,code),'hex'),Buffer.from(row.code_hash,'hex')))return {error:400};
   const consumed = await db.run('UPDATE buyer_recovery SET used=1 WHERE id=? AND used=0',id);
   if (!consumed.changes) return {error:400};
   // Only after proof of phone possession do we look up a paid, active grant.
   const order=await db.get("SELECT o.id,o.public_id FROM orders o JOIN entitlements e ON e.order_id=o.id WHERE o.customer_phone IN (?,?) AND o.status='PAID' AND o.access_type='vip' AND o.grant_type='subscription' AND e.grant_type='subscription' AND e.resource_type IS NULL AND e.resource_id IS NULL AND e.status='ACTIVE' AND (e.expires_at IS NULL OR e.expires_at>CURRENT_TIMESTAMP) ORDER BY o.created_at DESC,o.id DESC LIMIT 1",row.phone,row.phone.slice(2));
   if(!order)return {error:400};
   const token=crypto.randomBytes(32).toString('hex');
   await db.run('INSERT INTO buyer_sessions(id,order_id,token_hash,expires_at) VALUES (?,?,?,?)',crypto.randomUUID(),order.id,hash(token),Date.now()+180*86400000);
   return {orderId:order.public_id,token};
  });
  if(result.error)throw fail(result.error===429?'Aguarde alguns minutos antes de tentar novamente.':generic,result.error);
  return result;
 }
};}
async function owns(order,token){
 if(!order||typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return false;
 if(matches(token,order.checkout_hash))return true;
 return !!await (await getDb()).get('SELECT id FROM buyer_sessions WHERE order_id=? AND token_hash=? AND expires_at>?',order.id,hash(token),Date.now());
}
module.exports={...create(),create,owns};
