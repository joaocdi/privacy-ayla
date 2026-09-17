// Explicitly invoked integration check. Real Auth/Storage; simulated payments only.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
Object.assign(process.env,require('dotenv').parse(fs.readFileSync(path.join(__dirname,'../.env.account-staging'))));
if(process.env.APP_ENV!=='staging'||process.env.PAYMENT_PROVIDER!=='staging'||process.env.STAGING_DATABASE_SCHEMA!=='staging_ayla_preview')throw Error('Staging isolation required');
const database=require('../db/database');
const remoteBase=process.env.TEST_PREVIEW_URL;
if(remoteBase && (new URL(remoteBase).protocol!=='https:' || !/^privacy-ayla-[a-z0-9-]+\.vercel\.app$/.test(new URL(remoteBase).hostname)))throw Error('Only consolidated Preview is allowed');
const users=[],orders=[],uploads=[],posts=[];let server,db,base;
const password=crypto.randomBytes(24).toString('base64url');
async function supabase(route,body,method='POST'){
 const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 const r=await fetch(process.env.SUPABASE_URL+'/auth/v1/'+route,{method,headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 if(!r.ok)throw Error('Auth '+route.split('?')[0]+' HTTP '+r.status);return r.json();
}
async function req(route,{body,cookie='',csrf='',token='',method=body?'POST':'GET'}={}){
 const r=await fetch(base+route,{method,redirect:'manual',headers:{Origin:base,Cookie:cookie,'x-csrf-token':csrf,Authorization:'Bearer '+token,'Content-Type':Buffer.isBuffer(body)?'application/octet-stream':'application/json',...(Buffer.isBuffer(body)?{'upload-offset':'0'}:{})},body:body?Buffer.isBuffer(body)?body:JSON.stringify(body):undefined});
 const text=await r.text();let data;try{data=JSON.parse(text)}catch(_){data=text}if(r.status>=400)console.log('HTTP',route,r.status,typeof data==='object'?data.error:'');return {status:r.status,data,cookie:r.headers.get('set-cookie')?.split(';')[0],location:r.headers.get('location')};
}
(async()=>{
 db=await database.getDb();if(remoteBase){base=remoteBase;}else{await database.initDb();const {app}=require('../server');server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port;}console.log('Isolated Preview database ready');process.env.PUBLIC_APP_URL=base;process.env.ADMIN_ORIGIN=base;
 const adminEmail='privacy-admin-'+crypto.randomUUID()+'@example.com';
 const admin=await supabase('admin/users',{email:adminEmail,password,email_confirm:true});users.push(admin.id);
 await db.run("INSERT INTO admin_users(user_id,email,role) VALUES (?,?,'admin')",admin.id,adminEmail);
 const login=await req('/api/admin/login-email',{body:{email:adminEmail,password}});assert.equal(login.status,200);const cookie=login.cookie;
 const state=await req('/api/admin/session',{cookie});assert.equal(state.status,200);assert.equal(state.data.storage,'supabase');const csrf=state.data.csrf;
 const ffmpeg=require('@ffmpeg-installer/ffmpeg').path;
 const video=path.join(__dirname,'../.test-runs/v1-color.mp4'),thumb=path.join(__dirname,'../.test-runs/v1-thumb.jpg');
 const {execFileSync}=require('node:child_process');
 execFileSync(ffmpeg,['-y','-f','lavfi','-i','color=c=orange:s=160x240:d=1','-an','-c:v','libx264','-pix_fmt','yuv420p',video],{stdio:'ignore'});
 execFileSync(ffmpeg,['-y','-f','lavfi','-i','color=c=orange:s=32x48','-frames:v','1',thumb],{stdio:'ignore'});
 async function upload(bytes,mime){const start=await req('/api/admin/uploads',{cookie,csrf,body:{size:bytes.length,mime}});assert.equal(start.status,201);uploads.push(start.data.id);const done=await req('/api/admin/uploads/'+start.data.id,{cookie,csrf,method:'PATCH',body:bytes});assert.equal(done.status,200);assert.equal(done.data.complete,true);return start.data.id;}
 const photo=await upload(fs.readFileSync(path.join(__dirname,'../../verified-ayla.png')),'image/png');
 const film=await upload(fs.readFileSync(video),'video/mp4');
 const preview='data:image/jpeg;base64,'+fs.readFileSync(thumb).toString('base64');
 const input={caption:'V1 integration test',published:true,show_as_preview:true,sort_order:9000,likes_count:0,items:[{uploadId:photo,preview_image:preview},{uploadId:film,preview_image:preview}]};
 const post=await req('/api/admin/posts',{cookie,csrf,body:input});assert.equal(post.status,201);posts.push(post.data.id);
 const edited=await req('/api/admin/posts/'+post.data.id,{cookie,csrf,method:'PUT',body:{...input,version:post.data.version,caption:'V1 edited'}});assert.equal(edited.status,200);
 const previewFeed=await req('/api/home/previews');assert.equal(previewFeed.status,200);
 const adminMedia=await req('/api/admin/posts/'+post.data.id+'/media',{cookie});assert.equal(adminMedia.status,302);
 const media=await fetch(adminMedia.location);assert.equal(media.status,200);
 console.log('PASS real ADMIN Auth + private Storage: photo/video resumable uploads, carousel, edit, HOME endpoint and signed media');
 const token=crypto.randomBytes(32).toString('hex'),email='privacy-buyer-'+crypto.randomUUID()+'@example.com';
 const pix=await req('/api/payments/pix',{body:{productId:'ayla_monthly',checkoutToken:token}});assert.equal(pix.status,201);orders.push(pix.data.orderId);
 await req('/api/staging/confirm',{body:{orderId:pix.data.orderId,claimToken:token}});
 const registered=await req('/api/buyer/account/register',{body:{orderId:pix.data.orderId,claimToken:token,email,phone:'11999990000',password,confirmPassword:password}});assert.equal(registered.status,200);assert.ok(registered.cookie);
 const row=await db.get('SELECT buyer_id FROM orders WHERE public_id=?',pix.data.orderId);users.push(row.buyer_id);const buyerCookie=registered.cookie;
 const vip=await req('/api/vip/'+pix.data.orderId,{cookie:buyerCookie});assert.equal(vip.status,200);
 for(const post of vip.data.feed||[]){for(const item of post.items?.length?post.items:[post]){const asset=await req(item.media,{cookie:buyerCookie});assert.equal(asset.status,302,'VIP media redirect');const head=await fetch(asset.location,{method:'HEAD'});assert.equal(head.status,200,'Private object exists');}}
 console.log('PASS all consolidated VIP media resolve to existing private objects');
 assert.equal((await req('/api/admin/posts',{cookie:buyerCookie})).status,401);
 for(const productId of ['ayla_quarterly','ayla_semester','ayla_whatsapp_unlock']){const t=crypto.randomBytes(32).toString('hex');const p=await req('/api/payments/pix',{cookie:buyerCookie,body:{productId,checkoutToken:t,amount:0.01}});assert.equal(p.status,201);orders.push(p.data.orderId);await req('/api/staging/confirm',{body:{orderId:p.data.orderId,claimToken:t}});}
 const dashboard=await req('/api/buyer/account',{cookie:buyerCookie});assert.equal(dashboard.data.orders.length,4);
 const contact=dashboard.data.orders.find(o=>o.grant_type==='contact');assert.equal(contact.expires_at,null);assert.equal((await req('/api/vip/'+contact.public_id,{cookie:buyerCookie})).status,403);assert.equal((await req('/api/contact/'+contact.public_id,{cookie:buyerCookie})).status,200);
 console.log('PASS real BUYER Auth: automatic login, four products, VIP, permanent WhatsApp and role isolation');
 const requestedRedirect=(remoteBase||process.env.PUBLIC_APP_URL)+'/redefinir-senha';
 const recovery=await supabase('admin/generate_link?redirect_to='+encodeURIComponent(requestedRedirect),{type:'recovery',email});
 const redirect=new URL(recovery.action_link).searchParams.get('redirect_to');
 console.log('Recovery redirect configured: '+String(redirect===requestedRedirect));
 const verified=await supabase('verify',{type:'recovery',token_hash:recovery.hashed_token});
 const next=crypto.randomBytes(24).toString('base64url');
 const reset=await req('/api/buyer/account/reset',{body:{accessToken:verified.access_token,password:next,confirmPassword:next}});assert.equal(reset.status,200);
 assert.equal((await req('/api/buyer/account',{cookie:buyerCookie})).status,401);
 assert.equal((await req('/api/buyer/account/login',{body:{email,password}})).status,400);
 const again=await req('/api/buyer/account/login',{body:{email,password:next}});assert.equal(again.status,200);await req('/api/buyer/account/logout',{cookie:again.cookie,body:{}});assert.equal((await req('/api/buyer/account',{cookie:again.cookie})).status,401);
 console.log('PASS real Supabase recovery token, password reset, old password/session rejected, login and logout; no email sent');
 fs.writeFileSync(path.join(__dirname,'../.test-runs/v1-auth-result.json'),JSON.stringify({redirectConfigured:redirect===requestedRedirect,auth:true,storage:true,reset:true}));
})().catch(e=>{console.error('V1 real integration failed:',e.name,e.message);process.exitCode=1}).finally(async()=>{
 if(db){
  console.log('Removing only test fixtures');
  for(const id of posts){const p=await db.get('SELECT version FROM vip_posts WHERE id=?',id);if(p)await require('../services/vip-posts').deletePermanent(id,p.version).catch(()=>{});}
  for(const id of uploads){const row=await db.get('SELECT media_path FROM vip_uploads WHERE id=?',id);if(row)await require('../services/vip-media').removePrivate(row.media_path).catch(()=>{});await db.run('DELETE FROM vip_uploads WHERE id=?',id);}
  for(const id of orders){const row=await db.get('SELECT id FROM orders WHERE public_id=?',id);if(row){await db.run('DELETE FROM entitlements WHERE order_id=?',row.id);await db.run('DELETE FROM orders WHERE id=?',row.id);}}
  for(const id of users){await db.run('DELETE FROM buyer_account_sessions WHERE user_id=?',id);await db.run('DELETE FROM buyer_accounts WHERE user_id=?',id);await db.run('DELETE FROM admin_sessions WHERE secret_version=?','supabase:'+id);await db.run('DELETE FROM admin_users WHERE user_id=?',id);await supabase('admin/users/'+id,null,'DELETE').catch(()=>{});}
 }
 if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await database.closeDb();console.log('Real service validation and fixture cleanup complete');
});

