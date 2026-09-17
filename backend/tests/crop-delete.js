const assert = require('node:assert/strict');
async function contract(db) {
  const crop=require('../services/crop'),posts=require('../services/vip-posts'),profile=require('../services/profile'),media=require('../services/vip-media'),cleanup=require('../services/media-cleanup');
  let checks=0;const check=(v)=>{assert.ok(v);checks++;};
  for(const value of [{x:-1},{x:101},{y:-1},{y:101},{zoom:0},{zoom:4.1},{zoom:NaN},{ratio:'16:9'},{x:'50'},[],true]){assert.throws(()=>crop.normalize(value));checks++;}
  for(const ratio of ['original','1:1','4:5'])check(crop.normalize({ratio}).ratio===ratio);
  assert.throws(()=>crop.normalize({ratio:'4:5'},'avatar'));checks++;
  assert.throws(()=>crop.normalize({ratio:'1:1'},'cover'));checks++;
  let p=await profile.get();
  const avatar={x:10,y:80,zoom:2,ratio:'1:1'},cover={x:65,y:32,zoom:1.5,ratio:'2.44:1'};
  p=await profile.save({...p,avatarCrop:avatar,coverCrop:cover},'crop-test');
  assert.deepEqual((await profile.get()).avatarCrop,avatar);checks++;
  assert.deepEqual((await profile.get()).coverCrop,cover);checks++;
  await assert.rejects(profile.save({...p,coverCrop:{zoom:0}},'crop-test'),{status:400});checks++;
  assert.deepEqual((await profile.get()).coverCrop,cover);checks++;
  const raw=await db.get("SELECT avatar_crop,cover_crop FROM creator_profiles WHERE id='ayla'");check(Boolean(raw.avatar_crop&&raw.cover_crop));
  await posts.setSource('managed');
  await db.run("INSERT INTO vip_uploads(id,session_id,media_path,mime_type,type,size_bytes,complete,expires_at) VALUES ('crop-upload','crop-test','ayla/posts/crop-test.jpg','image/jpeg','image',100,1,?)",Date.now()+100000);
  const preview=Buffer.concat([Buffer.from([255,216,255,192,0,17,8,0,80,0,64,3]),Buffer.alloc(9),Buffer.from([255,217])]).toString('base64');
  let post=await posts.save(null,{uploadId:'crop-upload',caption:'crop test',sort_order:5,published:true,show_as_preview:true,preview_image:preview,crop:{x:20,y:60,zoom:1.7,ratio:'4:5'}},'crop-test');
  check(JSON.parse(post.crop_data).zoom===1.7);
  assert.deepEqual((await posts.findPublished(post.id)).crop,(await posts.homePreviews()).find(p=>p.id===post.id).crop);checks++;
  post=await posts.save(post.id,{caption:post.caption,sort_order:5,published:true,show_as_preview:true,version:post.version,crop:{x:30,y:80,zoom:2,ratio:'1:1'}},'crop-test');
  check(JSON.parse((await posts.list()).find(p=>p.id===post.id).crop_data).ratio==='1:1');
  await posts.archive(post.id,true,post.version);check(!(await posts.homePreviews()).some(p=>p.id===post.id));
  post=(await posts.list()).find(p=>p.id===post.id);await posts.archive(post.id,false,post.version);post=(await posts.list()).find(p=>p.id===post.id);check(!post.archived&&!post.published);
  const originalRemove=media.removePrivate;const removed=[];media.removePrivate=async path=>{removed.push(path);};
  try {
    await db.run("INSERT INTO vip_posts(id,type,media_path,media_driver,caption) VALUES ('crop-shared','image','ayla/posts/crop-test.jpg','supabase','shared')");
    check((await posts.deletePermanent(post.id,post.version)).storage==='shared');check(removed.length===0);check(!await posts.findPublished(post.id));
    check(!(await posts.list()).some(p=>p.id===post.id));
    await db.run("INSERT INTO orders(public_id,product_id,amount) VALUES ('crop-order','ayla_monthly',9.9)");
    const order=await db.get("SELECT id FROM orders WHERE public_id='crop-order'");
    await db.run("INSERT INTO vip_post_likes(id,post_id,order_id) VALUES ('crop-like','crop-shared',?)",order.id);
    check((await posts.deletePermanent('crop-shared',1)).storage==='done');check(removed.length===1);
    check(!(await db.get("SELECT id FROM vip_post_likes WHERE id='crop-like'")));
    await assert.rejects(posts.deletePermanent('crop-shared',1),{status:404});checks++;
    await assert.rejects(posts.save(null,{uploadId:'crop-upload',caption:'reuse',sort_order:1,published:false},'crop-test'),{status:409});checks++;
    await db.run("INSERT INTO vip_posts(id,type,media_path,media_driver) VALUES ('crop-fail','image','ayla/posts/failure.jpg','supabase')");
    media.removePrivate=async()=>{throw Error('simulated Storage outage')};
    check((await posts.deletePermanent('crop-fail',1)).storage==='pending');
    check(!(await db.get("SELECT id FROM vip_posts WHERE id='crop-fail'")));check((await db.get("SELECT status FROM media_deletions WHERE media_path='ayla/posts/failure.jpg'")).status==='pending');
    media.removePrivate=async path=>removed.push(path);check(await cleanup.clean('ayla/posts/failure.jpg')==='done');
    await db.run("INSERT INTO vip_posts(id,type,media_path,media_driver) VALUES ('crop-profile-ref','image','ayla/posts/avatar.jpg','supabase')");
    await db.run("UPDATE creator_profiles SET avatar_path='ayla/posts/avatar.jpg' WHERE id='ayla'");
    check((await posts.deletePermanent('crop-profile-ref',1)).storage==='shared');check(!removed.includes('ayla/posts/avatar.jpg'));
  } finally {media.removePrivate=originalRemove;}
  const fs=require('fs'),path=require('path');check(fs.readFileSync(path.resolve(__dirname,'../../style.css'),'utf8').includes('blur(10px)'));
  const f=require('../../frame');const g=f.geometry({x:100,y:0,zoom:2},400,800,200,200);check(g.left<=0&&g.top===0&&g.width>=200&&g.height>=200);
  console.log(`PASS crop/delete: ${checks} checks (validation, profile/post persistence, matching public/VIP crop, archive/restore, shared media, cleanup failure/retry)`);
}
module.exports=contract;
if(require.main===module){require('./sqlite-env');process.env.VIP_MEDIA_DRIVER='supabase';process.env.DATABASE_PATH=require('path').join(__dirname,'../.test-runs/crop-'+require('crypto').randomUUID()+'.sqlite');const db=require('../db/database');db.initDb().then(contract).catch(e=>{console.error(e);process.exitCode=1}).finally(()=>db.closeDb());}
