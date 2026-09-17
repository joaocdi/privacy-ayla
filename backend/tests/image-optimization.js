require('./sqlite-env');
const assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path');
Object.assign(process.env,{DATABASE_PATH:path.resolve(__dirname,'../.test-runs/images-'+crypto.randomUUID()+'.sqlite'),PAYMENT_PROVIDER:'mock',SUPABASE_URL:'https://storage.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture-key',VIP_MEDIA_BUCKET:'private-fixture'});
const realFetch=global.fetch;
global.fetch=async(url,options)=>String(url).startsWith('https://storage.invalid')
  ? new Response(Buffer.from('profile-fixture'),{headers:{'Content-Type':'image/webp'}}):realFetch(url,options);
const {app}=require('../server'),database=require('../db/database');
const {chromium}=require('../.test-runs/browser/node_modules/playwright');
let server,browser;
(async()=>{
 await database.initDb();const db=await database.getDb();
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const profile=await fetch(base+'/api/profile');assert.equal(profile.headers.get('cache-control'),'public, max-age=60, stale-while-revalidate=600');
 await db.run("INSERT INTO creator_profiles(id,name,username,bio,avatar_path,cover_path,version) VALUES ('ayla','Ayla','@test','bio','ayla/profile/a.webp','ayla/profile/c.webp',7)");
 process.env.VIP_MEDIA_DRIVER='supabase';
 const image=await fetch(base+'/api/profile/media/avatar?v=7');assert.equal(image.status,200);assert.equal(image.headers.get('cache-control'),'public, max-age=31536000, immutable');assert.equal(image.headers.get('content-type'),'image/webp');assert.equal(await image.text(),'profile-fixture');
 const outdated=await fetch(base+'/api/profile/media/avatar?v=6',{redirect:'manual'});assert.equal(outdated.status,302);assert.equal(outdated.headers.get('cache-control'),'no-store');assert.equal(outdated.headers.get('location'),'/api/profile/media/avatar?v=7');
 assert.equal((await fetch(base+'/api/profile/media/post?v=7')).status,404);
 assert.equal((await fetch(base+'/api/catalog')).headers.get('cache-control'),'no-store');
 await db.run("DELETE FROM creator_profiles WHERE id='ayla'");process.env.VIP_MEDIA_DRIVER='local';
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const page=await browser.newPage({viewport:{width:390,height:850}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.waitForFunction(()=>document.getElementById('coverImg').complete&&document.getElementById('coverImg').naturalWidth>0);
 assert.equal(await page.locator('#ageGate').isVisible(),true,'profile downloads before confirmation without bypassing age gate');
 assert.equal(await page.locator('#avatarImg').evaluate(e=>e.complete&&e.naturalWidth>0),true);
 await page.addScriptTag({url:base+'/image-tools.js'});
 const result=await page.evaluate(async()=>{
  const c=document.createElement('canvas');c.width=1792;c.height=2400;const x=c.getContext('2d');const g=x.createLinearGradient(0,0,c.width,c.height);g.addColorStop(0,'#ff6000');g.addColorStop(1,'#0033ff');x.fillStyle=g;x.fillRect(0,0,c.width,c.height);
  const file=new File([await new Promise(r=>c.toBlob(r,'image/jpeg',.95))],'fixture.jpg',{type:'image/jpeg'});const results={};
  for(const role of ['avatar','cover']){const f=await AylaImageTools.profile(file,role);const img=await createImageBitmap(f);results[role]={bytes:f.size,width:img.width,height:img.height};img.close();}
  const uri=AylaImageTools.preview(c,c.width,c.height);const img=new Image();img.src=uri;await img.decode();results.preview={width:img.naturalWidth,height:img.naturalHeight,bytes:atob(uri.split(',')[1]).length};return results;
 });
 assert(result.avatar.bytes<=25*1024&&result.avatar.width<=320&&result.avatar.height<=320);assert(result.cover.bytes<=150*1024&&result.cover.width<=1280);
 assert(Math.abs(result.avatar.width/result.avatar.height-1792/2400)<.002,'source aspect ratio retained for relative crop');
 assert.deepEqual([result.preview.width,result.preview.height],[160,200]);assert(result.preview.bytes<=24*1024);
 assert.deepEqual(errors,[]);
 console.log('PASS images: anonymous public cache, immutable versioned branding only, old-version redirect, private API no-store, age gate retained, pre-consent image downloads, profile upload budgets/aspect ratio, baked 40x50 preview',JSON.stringify(result));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{global.fetch=realFetch;if(browser)await browser.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await database.closeDb();});
