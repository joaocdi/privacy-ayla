require('./sqlite-env');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
process.env.DATABASE_PATH = path.resolve(__dirname, '../.test-runs/likes-' + crypto.randomUUID() + '.sqlite');
process.env.PAYMENT_PROVIDER = 'mock';
process.env.VIP_MEDIA_DRIVER = 'local';
process.env.VIP_MEDIA_DIRS = 'previews';
process.env.FRONTEND_URL = '';
const { app } = require('../server');
const { getDb, closeDb } = require('../db/database');
const posts = require('../services/vip-posts');
let server, browser;
const qaWarnings = [];
async function main() {
  await require('../db/database').initDb(); const db = await getDb();
  const token = crypto.randomBytes(32).toString('hex');
  const order = await require('../services/orders').createOrder(require('../products').ayla_monthly, token, 'mock');
  await require('../services/orders').updateOrderPayment(order.public_id, await require('../payments/mock-provider').createPixPayment({orderId:order.public_id}));
  await require('../services/entitlements').confirmPayment(order.public_id);
  const preview = fs.readFileSync(path.resolve(__dirname, '../../previews/post-01.jpg')).toString('base64');
  await db.run("INSERT INTO vip_posts(id,type,media_path,media_driver,published,show_as_preview,preview_image,likes_count) VALUES ('like-qa','image','previews/post-01.jpg','local',1,1,?,318)", preview);
  await posts.setSource('managed');
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const route = '/api/vip/' + order.public_id + '/posts/like-qa/like';
  const put = (liked, auth=true, suffix=route) => fetch(base+suffix,{method:'PUT',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({liked})});
  for(const liked of [true,false]) assert.equal((await put(liked,false)).status,403);
  for(const liked of [true,true,false,false]) {
    const r=await put(liked); assert.equal(r.status,200); assert.equal((await r.json()).likes,318+Number(liked));
    const feed=await posts.feed(order.id); assert.equal(feed[0].liked,liked); assert.equal(feed[0].likes,318+Number(liked));
    assert.equal((await posts.homePreviews())[0].likes_count,318+Number(liked));
  }
  await Promise.all(Array.from({length:8},()=>put(true)));
  assert.equal((await posts.feed(order.id))[0].likes,319);
  await Promise.all(Array.from({length:8},()=>put(false)));
  assert.equal((await posts.feed(order.id))[0].likes,318);
  assert.equal((await put(true,true,route.replace('like-qa','missing'))).status,404);
  for(const field of ['archived','published']) {
    await db.run(`UPDATE vip_posts SET ${field}=? WHERE id='like-qa'`,field==='archived'?1:0);
    for(const liked of [true,false]) assert.equal((await put(liked)).status,404);
    await db.run(`UPDATE vip_posts SET ${field}=? WHERE id='like-qa'`,field==='archived'?0:1);
  }
  const publicData = JSON.stringify(await posts.homePreviews());
  for(const secret of ['media_path','order_id',token,'webhookToken']) assert.ok(!publicData.includes(secret));
  console.log('PASS likes: authorization, duplicate like/unlike, archived/draft/missing posts, reload state, HOME count and privacy');
  if(process.env.LIKES_BROWSER_QA==='1') {
    for (let n=1;n<=3;n++) await db.run("INSERT INTO vip_post_media(id,post_id,type,media_path,media_driver,sort_order,preview_image) VALUES (?,'like-qa','image',?,'local',?,?)",'slide-'+n,'previews/post-0'+n+'.jpg',n,preview);
    await db.run("INSERT INTO vip_posts(id,type,media_path,media_driver,published,show_as_preview,preview_image,preview_video,sort_order) VALUES ('teaser-qa','video','previews/test.mp4','local',1,1,?,'ayla/previews/likes-qa.mp4',100)",preview);
    const teaserFile=path.resolve(__dirname,'../.test-runs/likes-teaser.mp4');
    require('child_process').execFileSync(require('@ffmpeg-installer/ffmpeg').path,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=orange:s=160x200:r=15','-t','3','-an','-c:v','libx264','-pix_fmt','yuv420p',teaserFile]);
    const { chromium } = require('../.test-runs/browser/node_modules/playwright');
    browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
    for(const width of [320,375,390,430,768,1280]) {
      const context=await browser.newContext({viewport:{width,height:850},hasTouch:width<768});
      const page=await context.newPage();
      // Browser-only synthetic teaser; real delivery is covered by API security tests.
      await page.route('**/api/home/preview-video/teaser-qa',r=>r.fulfill({path:teaserFile,contentType:'video/mp4'}));
      await page.goto(base+'/vip#o='+order.public_id+'&t='+token);
      const advance = async () => {
        if(width>=768) await page.locator('.car-arrow-next').first().click();
        else {
          const track=page.locator('.car-track').first(); await track.scrollIntoViewIfNeeded();
          const box=await track.boundingBox(); const cdp=await context.newCDPSession(page);
          const y=Math.max(80,Math.min(700,box.y+box.height/2));
          const start=box.x+box.width*.85, end=box.x+box.width*.15;
          await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:start,y}]});
          for(let n=1;n<=10;n++) {await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start+(end-start)*n/10,y}]}); await page.waitForTimeout(20);}
          await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}); await cdp.detach();
        }
        await page.waitForFunction(()=>document.querySelector('.car-count')?.textContent==='2/3',null,{timeout:4000});
      };
      const heart=page.locator('.vip-like').first(); await heart.waitFor();
      if(width>=768) {await heart.hover(); assert.equal(await heart.locator('svg').evaluate(e=>getComputedStyle(e).fill),'rgb(227, 38, 70)');}
      assert.equal(await heart.getAttribute('aria-pressed'),'false');
      await heart.click();
      await page.waitForFunction(()=>document.querySelector('.vip-like')?.disabled===false);
      assert.equal(await heart.textContent(),'319');
      assert.equal(await heart.getAttribute('aria-pressed'),'true');
      assert.equal(await heart.locator('svg').evaluate(e=>getComputedStyle(e).fill),'rgb(227, 38, 70)');
      await page.screenshot({path:path.resolve(__dirname,'../.test-runs/likes-vip-'+width+'.png')});
      await page.reload(); await heart.waitFor();
      assert.equal(await heart.getAttribute('aria-pressed'),'true'); assert.equal(await heart.textContent(),'319');
      await heart.click(); await page.waitForFunction(()=>document.querySelector('.vip-like')?.disabled===false);
      assert.equal(await heart.textContent(),'318'); assert.equal(await heart.getAttribute('aria-pressed'),'false');
      await page.mouse.move(0,0);
      assert.equal(await heart.locator('svg').evaluate(e=>getComputedStyle(e).fill),'none');
      assert.ok(await page.locator('.vip-gift').count());
      assert.equal(await page.locator('.vip-like').count(),1,'carousel has one heart');
      await advance();
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.goto(base+'/'); await page.locator('#ageConfirm').click(); await page.waitForSelector('.preview-post[data-post-id="like-qa"]');
      assert.ok((await page.locator('.preview-engagement').first().textContent()).includes('318'));
      assert.equal(await page.locator('#btnMimo').count(),0);
      assert.ok(!(await page.locator('body').innerText()).includes('Mimo'));
      await page.locator('.preview-engagement').first().click();
      assert.equal((await posts.feed(order.id))[0].likes,318);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      try { await advance(); } catch (e) {
        qaWarnings.push(width); console.log('QA WARNING HOME '+width+': native carousel swipe did not advance; existing carousel code unchanged');
      }
      const teaser=page.locator('.preview-post[data-post-id="teaser-qa"] video');
      await teaser.scrollIntoViewIfNeeded();
      await teaser.evaluate(v=>{if(v.currentTime===0 && v.paused) return v.play();});
      await page.waitForFunction(()=>{const v=document.querySelector('[data-post-id="teaser-qa"] video');return v?.paused && v.currentTime>=2.5;});
      assert.ok(await teaser.evaluate(v=>v.paused && v.currentTime<=3.1));
      await page.screenshot({path:path.resolve(__dirname,'../.test-runs/likes-home-'+width+'.png')});
      console.log('PASS browser HOME/VIP '+width+': like/unlike, red, refresh, count, Mimo visibility, no overflow');
      await context.close();
    }
  }
  if(qaWarnings.length) {console.log('BROWSER QA INCOMPLETE: HOME swipe at '+qaWarnings.join(', '));process.exitCode=1;}
  await db.run("UPDATE entitlements SET status='EXPIRED' WHERE order_id=?",order.id);
  for(const liked of [true,false]) assert.equal((await put(liked)).status,403);
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{
  if(browser) await browser.close();
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  await closeDb();
});

