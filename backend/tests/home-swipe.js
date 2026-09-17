/** Browser regression for HOME hit testing and native touch scrolling.
 * Isolated SQLite + synthetic public derivatives; no real orders or Storage.
 * Run: node tests/home-swipe.js (uses the local QA Playwright installation).
 */
require('./sqlite-env');
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),crypto=require('crypto');
process.env.DATABASE_PATH=path.resolve(__dirname,'../.test-runs/home-swipe-'+crypto.randomUUID()+'.sqlite');
process.env.PAYMENT_PROVIDER='mock';process.env.FRONTEND_URL='';
const {app}=require('../server'); const database=require('../db/database');
const {chromium}=require('../.test-runs/browser/node_modules/playwright');
let server,browser;
async function main(){
 await database.initDb();server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port;
 const preview='data:image/jpeg;base64,'+fs.readFileSync(path.resolve(__dirname,'../../previews/post-01.jpg')).toString('base64');
 const videoFile=path.resolve(__dirname,'../.test-runs/home-swipe-teaser.mp4');
 require('child_process').execFileSync(require('@ffmpeg-installer/ffmpeg').path,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=orange:s=160x200:r=15','-t','3','-an','-c:v','libx264','-pix_fmt','yuv420p',videoFile]);
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 for(const width of [320,375,390,430]) for(const types of [['image','image','image'],['image','video'],['video','video']]){
  const ctx=await browser.newContext({viewport:{width,height:850},hasTouch:true});const page=await ctx.newPage();let paymentCalls=0;
  await page.route('**/api/payments/pix',r=>{paymentCalls++;return r.abort();});
  await page.route('**/api/catalog',async r=>{const response=await r.fetch();const body=await response.json();body.requiresClient=true;await r.fulfill({json:body});});
  await page.route('**/api/home/preview-video/**',r=>r.fulfill({path:videoFile,contentType:'video/mp4'}));
  const item={id:'swipe-fixture',type:types[0],preview,caption:'QA swipe',likes_count:318,teaserSeconds:3,
    items:types.map((type,n)=>({id:'item-'+n,type,preview,crop:{ratio:'4:5',x:50,y:50,zoom:1},teaser:type==='video'?'/api/home/preview-video/swipe-fixture/item-'+n:null}))};
  await page.route('**/api/home/previews',r=>r.fulfill({json:{source:'managed',previews:[item]}}));
  await page.goto(base+'/');await page.locator('#ageConfirm').click();const card=page.locator('[data-post-id="swipe-fixture"]');await card.waitFor();
  const track=card.locator('.car-track'),counter=card.locator('.car-count');
  const center=async()=>{await track.evaluate(e=>{const b=e.getBoundingClientRect();window.scrollBy({top:b.top-(innerHeight-b.height)/2,behavior:'instant'});});await page.waitForTimeout(100);return track.boundingBox();};
  const gesture=async(direction,vertical=false)=>{
    const b=await center(),cdp=await ctx.newCDPSession(page);
    const y=b.y+b.height*.25,x0=b.x+b.width*(direction<0?.85:.15),x1=b.x+b.width*(direction<0?.15:.85);
    const x=vertical?b.x+b.width*.8:x0,sy=vertical?Math.min(500,b.y+b.height*.3):y;
    const hit=await page.evaluate(({x,y})=>({tag:document.elementFromPoint(x,y)?.className,inside:!!document.elementFromPoint(x,y)?.closest('.car-track')}),{x,y:sy}); assert.equal(hit.inside,true,'touch begins inside track: '+JSON.stringify({hit,b,x,y:sy}));
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:sy}]});
    for(let n=1;n<=12;n++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:vertical?x:x0+(x1-x0)*n/12,y:vertical?sy+180*n/12:sy}]});await page.waitForTimeout(20);}
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
  };
  const state=async n=>{
    await page.waitForFunction(({n,total})=>document.querySelector('.car-count')?.textContent===n+'/'+total,{n,total:types.length},{timeout:4000});
    await page.waitForFunction(n=>{const track=document.querySelector('.car-track');return Math.abs(track.scrollLeft-(n-1)*track.clientWidth)<2;},n,{timeout:4000});
    assert.equal(await card.locator('.car-dot').evaluateAll(dots=>dots.findIndex(d=>d.classList.contains('is-on'))),n-1);
    assert.ok((await card.locator('.preview-engagement').textContent()).includes('318'));
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  };
  await state(1);
  for(let n=2;n<=types.length;n++){await gesture(-1);await state(n);}
  for(let n=types.length-1;n>=1;n--){await gesture(1);await state(n);}
  // Vertical scrolling starts over the same media and must keep its slide.
  await center();const scrollBefore=await page.evaluate(()=>scrollY);await gesture(-1,true);
  await page.waitForFunction(before=>scrollY<before-40,scrollBefore,{timeout:4000});await state(1);
  // Tapping the CTA is a click, not an accidental slide; no PIX is created.
  assert.equal(paymentCalls,0,'gestures must not open checkout');
  await card.locator('.btn-unlock').tap();await page.waitForSelector('#checkoutModalOverlay.open');
  assert.equal(await counter.textContent(),'1/'+types.length);assert.equal(paymentCalls,1);
  await page.evaluate(()=>closeCheckout());
  // Exercise each video slide: only public derivative URLs and bounded playback.
  for(let n=0;n<types.length;n++){
    if(n){await gesture(-1);await state(n+1);}
    if(types[n]==='video'){
      const cell=card.locator('.car-cell').nth(n),video=cell.locator('video');
      await cell.scrollIntoViewIfNeeded();
      if(await video.evaluate(v=>v.currentTime===0 && v.paused)) await video.evaluate(v=>v.play());
      await page.waitForFunction(index=>{const v=document.querySelectorAll('.car-cell')[index]?.querySelector('video');return v && !v.paused && v.currentTime>.1 && v.loop;},n,{timeout:8000});
      assert.ok(await video.evaluate(v=>v.currentTime<=3.1 && new URL(v.src).pathname.startsWith('/api/home/preview-video/')));
      assert.ok(await cell.evaluate(e=>e.classList.contains('teaser-ready')));
    }
  }
  await page.screenshot({path:path.resolve(__dirname,'../.test-runs/home-swipe-'+width+'-'+types.join('-')+'.png')});
  assert.equal(paymentCalls,1);console.log('PASS HOME '+width+' '+types.join('+')+': left/right, counter/dots, CTA, vertical scroll, count, derivative teaser, no overflow');
  await ctx.close();
 }
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await database.closeDb();});



