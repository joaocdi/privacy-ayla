'use strict';
const crypto=require('node:crypto');
const {getDb,transaction}=require('../db/database');
const {hash,matches}=require('./security');
const normalizePhone=require('./buyer-phone');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const enabled=()=>process.env.BUYER_ACCOUNT_FLOW==='true';
const cookieName=()=>process.env.NODE_ENV==='production'?'__Host-ayla-buyer-account':'ayla-buyer-account';
function cookie(req){return (req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName()+'='))?.split('=')[1];}
function origin(req){
  const expected=process.env.PUBLIC_APP_URL || (process.env.NODE_ENV!=='production'?req.protocol+'://'+req.get('host'):null);
  if(!expected || req.get('origin')!==new URL(expected).origin || req.get('sec-fetch-site')==='cross-site') throw fail('Origem inválida.',403);
}
async function limit(req){
  const allowed=await transaction(async db=>{
    const id=hash('buyer-auth:'+req.ip),now=Date.now();
    await db.run('INSERT INTO buyer_recovery_limits(id,hits,reset_at) VALUES (?,0,?) ON CONFLICT(id) DO NOTHING',id,now+900000);
    await db.run('UPDATE buyer_recovery_limits SET hits=CASE WHEN reset_at<=? THEN 1 ELSE hits+1 END,reset_at=CASE WHEN reset_at<=? THEN ? ELSE reset_at END WHERE id=?',now,now,now+900000,id);
    return Number((await db.get('SELECT hits FROM buyer_recovery_limits WHERE id=?',id)).hits)<=30;
  });
  if(!allowed)throw fail('Muitas tentativas. Aguarde alguns minutos.',429);
}
async function auth(route,body,token,admin=false){
  const url=process.env.SUPABASE_URL,key=admin?process.env.SUPABASE_SERVICE_ROLE_KEY:process.env.SUPABASE_ANON_KEY;
  if(!/^https:\/\//.test(url||'')||!key)throw fail('Autenticação indisponível.',503);
  const response=await fetch(url.replace(/\/$/,'')+'/auth/v1/'+route,{method:body?(route==='user'?'PUT':'POST'):'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{apikey:key,Authorization:'Bearer '+(token||key),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  if(!response.ok)throw fail('Não foi possível autenticar. Confira seus dados ou tente novamente.',response.status===429?429:400);
  return response.json();
}
async function session(req){
  const value=cookie(req);if(!/^[a-f0-9]{64}$/.test(value||''))return null;
  return (await getDb()).get("SELECT a.* FROM buyer_account_sessions s JOIN buyer_accounts a ON a.user_id=s.user_id WHERE s.id=? AND s.expires_at>? AND a.role='BUYER'",hash(value),Date.now());
}
async function setSession(res,userId){
  const value=crypto.randomBytes(32).toString('hex');
  await (await getDb()).run('INSERT INTO buyer_account_sessions(id,user_id,expires_at) VALUES (?,?,?)',hash(value),userId,Date.now()+30*86400000);
  res.cookie(cookieName(),value,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',path:'/',maxAge:30*86400000});
}
async function eligible(orderId,claimToken,db=undefined){
  const order=await (db||await getDb()).get('SELECT * FROM orders WHERE public_id=?',orderId);
  if(!order||!require('../creator').ownsProduct(order.product_id)||!order.claim_required||order.status!=='PAID'||order.buyer_id||!matches(claimToken,order.claim_token_hash))throw fail('Compra não disponível para cadastro. Confirme o pagamento e use este navegador.',403);
  return order;
}
async function claim(userId,orderId,claimToken){
  return transaction(async db=>{
    const existing=await db.get('SELECT * FROM orders WHERE public_id=?',orderId);
    if(require('../creator').ownsProduct(existing?.product_id)&&existing?.buyer_id===userId&&existing.status==='PAID')return existing;
    const order=await eligible(orderId,claimToken,db);
    if(order.purchase_buyer_id && order.purchase_buyer_id!==userId)throw fail('Compra vinculada a outra conta.',403);
    const result=await db.run('UPDATE orders SET buyer_id=?,claimed_at=CURRENT_TIMESTAMP,claim_token_hash=NULL WHERE id=? AND buyer_id IS NULL AND status=\'PAID\' AND claim_token_hash=?',userId,order.id,order.claim_token_hash);
    if(!result.changes)throw fail('Compra já reivindicada.',409);
    const claimed=await db.get('SELECT * FROM orders WHERE id=?',order.id);
    await require('./entitlements').insertEntitlement(db,claimed);
    return claimed;
  });
}
function credentials(body){
  const email=typeof body.email==='string'?body.email.trim().toLowerCase():'';
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||typeof body.password!=='string'||body.password.length<8||body.password.length>128)throw fail('Informe e-mail válido e senha de 8 a 128 caracteres.');
  return {email,password:body.password};
}
function install(app){
  const route=(name,handler)=>app.post('/api/buyer/account/'+name,async(req,res)=>{
    res.set('Cache-Control','no-store');
    try{if(!enabled())return res.sendStatus(404);origin(req);await limit(req);await handler(req,res);}catch(e){res.status(e.status||502).json({error:e.status?e.message:'Serviço indisponível. Tente novamente.'});}
  });
  app.get('/api/buyer/account',async(req,res,next)=>{try{
    res.set('Cache-Control','no-store');if(!enabled())return res.json({enabled:false});
    const buyer=await session(req);if(!buyer)return res.status(401).json({enabled:true});
    const orders=await (await getDb()).all("SELECT o.public_id,o.product_id,o.amount,e.expires_at,e.status,e.grant_type FROM orders o JOIN entitlements e ON e.order_id=o.id WHERE o.buyer_id=? AND o.status='PAID' ORDER BY o.id DESC",buyer.user_id);
    res.json({enabled:true,email:buyer.email,role:'BUYER',orders});
  }catch(e){next(e);}});
  route('register',async(req,res)=>{
    const body=req.body||{},c=credentials(body),phone=normalizePhone(body.phone);
    if(!phone||body.confirmPassword!==c.password)throw fail('Confira celular e confirmação da senha.');
    await eligible(body.orderId,body.claimToken);
    const db=await getDb();
    if(await db.get('SELECT user_id FROM admin_users WHERE lower(email)=?',c.email))throw fail('Use uma conta de comprador.',403);
    // Only a paid, unclaimed purchase can create a BUYER. This server-only
    // operation confirms signup without changing global ADMIN/Auth settings.
    // Existing users are never overwritten; they must use password login.
    const created=await auth('admin/users',{...c,email_confirm:true,user_metadata:{account_type:'BUYER',phone}},null,true);
    const createdId=created.id||created.user?.id;
    if(!createdId)throw fail('Não foi possível criar a conta. Se já tem cadastro, entre.');
    const data=await auth('token?grant_type=password',c);
    const user=await auth('user',null,data.access_token);
    if(user.id!==createdId)throw fail('Não foi possível validar sua conta.',403);
    if(await db.get('SELECT user_id FROM admin_users WHERE user_id=?',user.id))throw fail('Use uma conta de comprador.',403);
    await db.run("INSERT INTO buyer_accounts(user_id,email,phone) VALUES (?,?,?) ON CONFLICT(user_id) DO NOTHING",user.id,c.email,phone);
    await claim(user.id,body.orderId,body.claimToken);await setSession(res,user.id);res.json({ok:true});
  });
  route('login',async(req,res)=>{
    const c=credentials(req.body||{}),data=await auth('token?grant_type=password',c),user=data.user;
    if(!user?.id)throw fail('E-mail ou senha inválidos.',401);
    const db=await getDb();if(await db.get('SELECT user_id FROM admin_users WHERE user_id=?',user.id))throw fail('Use o acesso administrativo.',403);
    let buyer=await db.get("SELECT * FROM buyer_accounts WHERE user_id=? AND role='BUYER'",user.id);
    if(!buyer){
      await eligible(req.body.orderId,req.body.claimToken);
      const phone=normalizePhone(user.user_metadata?.phone || req.body.phone);
      if(!phone)throw fail('Informe o celular para concluir seu cadastro.');
      await db.run('INSERT INTO buyer_accounts(user_id,email,phone) VALUES (?,?,?) ON CONFLICT(user_id) DO NOTHING',user.id,user.email,phone);
    }
    if(req.body.orderId)await claim(user.id,req.body.orderId,req.body.claimToken);
    await setSession(res,user.id);res.json({ok:true});
  });
  route('claim',async(req,res)=>{const buyer=await session(req);if(!buyer)throw fail('Entre na sua conta.',401);await claim(buyer.user_id,req.body.orderId,req.body.claimToken);res.json({ok:true});});
  route('logout',async(req,res)=>{const value=cookie(req);if(value)await (await getDb()).run('DELETE FROM buyer_account_sessions WHERE id=?',hash(value));res.clearCookie(cookieName(),{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',path:'/'});res.json({ok:true});});
  route('recover',async(req,res)=>{
    const email=String(req.body.email||'').trim().toLowerCase();
    if(await (await getDb()).get("SELECT user_id FROM buyer_accounts WHERE email=? AND role='BUYER'",email))await auth('recover?redirect_to='+encodeURIComponent(process.env.PUBLIC_APP_URL+'/redefinir-senha'),{email});
    res.json({message:'Se houver uma conta com este e-mail, você receberá as instruções para redefinir a senha.'});
  });
  route('reset',async(req,res)=>{
    const {password,confirmPassword,accessToken}=req.body;
    if(typeof password!=='string'||password.length<8||password.length>128||password!==confirmPassword||typeof accessToken!=='string'||accessToken.length>10000)throw fail('Confira a nova senha.');
    const user=await auth('user',null,accessToken),db=await getDb();
    if(!await db.get("SELECT user_id FROM buyer_accounts WHERE user_id=? AND role='BUYER'",user.id)||await db.get('SELECT user_id FROM admin_users WHERE user_id=?',user.id))throw fail('Acesso inválido.',403);
    await auth('user',{password},accessToken);await db.run('DELETE FROM buyer_account_sessions WHERE user_id=?',user.id);res.json({ok:true});
  });
}
module.exports={enabled,session,claim,eligible,install,origin};
