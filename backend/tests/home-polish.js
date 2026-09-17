require('./sqlite-env');
const assert = require('node:assert/strict'), crypto = require('node:crypto'), path = require('node:path'), fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const fixture = path.resolve(__dirname, '../.test-runs/home-' + crypto.randomUUID());
Object.assign(process.env, { BUYER_ACCOUNT_FLOW: 'true', PAYMENT_PROVIDER: 'mock', DATABASE_PATH: fixture + '.sqlite' });
const ffmpeg = require('@ffmpeg-installer/ffmpeg').path;
execFileSync(ffmpeg, ['-y','-f','lavfi','-i','testsrc2=size=320x400:rate=24','-t','1','-an','-c:v','libvpx','-b:v','300k',fixture+'.webm'], {stdio:'ignore'});
execFileSync(ffmpeg, ['-y','-f','lavfi','-i','color=c=gray:s=64x80','-frames:v','1',fixture+'.jpg'], {stdio:'ignore'});
const { app } = require('../server'), db = require('../db/database');
const { chromium } = require('../.test-runs/browser/node_modules/playwright');
let browser, server;
(async () => {
  await db.initDb(); server = app.listen(0,'127.0.0.1'); await new Promise(r => server.once('listening',r));
  const base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const page = await browser.newPage({viewport:{width:390,height:850}});
  await page.route('**/api/home/previews', route => route.fulfill({json:{source:'managed',previews:[{id:'fixture',type:'video',preview:'data:image/jpeg;base64,'+fs.readFileSync(fixture+'.jpg').toString('base64'),teaser:'/api/home/preview-video/fixture',teaserSeconds:1,caption:'Prévia de teste',likes_count:0}]}}));
  await page.route('**/api/home/preview-video/fixture', route => route.fulfill({path:fixture+'.webm',contentType:'video/webm'}));
  await page.goto(base); await page.locator('#ageConfirm').click();
  for (const width of [320,390,430,1280]) {
    await page.setViewportSize({width,height:850});
    const layout = await page.evaluate(() => {
      const header=document.querySelector('.topbar').getBoundingClientRect(), logo=document.querySelector('.topbar .logo-text').getBoundingClientRect(), account=document.querySelector('.member-link').getBoundingClientRect();
      return {delta:Math.abs((logo.x+logo.width/2)-(header.x+header.width/2)),overlap:logo.right>account.left,overflow:document.documentElement.scrollWidth>innerWidth};
    });
    assert(layout.delta < 1); assert(!layout.overlap); assert(!layout.overflow);
  }
  assert.equal(await page.locator('#offerSave').textContent(),'50% OFF');
  const video=page.locator('.locked-video'); await video.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => { const v=document.querySelector('.locked-video');return v&&!v.paused&&v.readyState>=2; });
  await video.evaluate(v => { window.testLoops=0;v.addEventListener('seeking',()=>window.testLoops++); });
  await page.waitForFunction(() => window.testLoops>=2);
  assert.equal(await video.evaluate(v=>v.loop&&v.muted),true);
  assert.equal(await page.getByText('Ver de novo',{exact:false}).count(),0);
  assert.equal(await page.locator('.locked-replay').isVisible(),false);
  await page.evaluate(()=>scrollTo(0,0)); await page.waitForFunction(()=>document.querySelector('.locked-video').paused);
  await page.locator('#btnPlan1m').click(); await page.locator('#pixActiveArea').waitFor({state:'visible'}); await page.evaluate(()=>closeCheckout());
  await page.locator('#pendingPixNotice').waitFor({state:'visible'});
  assert.equal(await page.locator('#pendingPixNotice').evaluate(e=>e.open),false);
  await page.locator('#pendingPixNotice summary').click();
  await page.getByRole('button',{name:'Dispensar aviso de 1 mês',exact:true}).click();
  await page.locator('#pendingPixNotice').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>AylaCheckouts.list().length),1,'dismiss must preserve claim');
  await page.evaluate(async()=>{const item=AylaCheckouts.list()[0];delete item.noticeDismissedAt;item.createdAt=Date.now()-31*60000;localStorage.setItem(AylaCheckouts.prefix+item.token,JSON.stringify(item));await refreshPendingPixNotice();});
  assert.equal(await page.locator('#pendingPixNotice').isVisible(),false,'old unpaid notice disappears');
  const item=await page.evaluate(()=>AylaCheckouts.list()[0]);
  await require('../services/entitlements').confirmPayment(item.payment.orderId);
  await page.evaluate(()=>refreshPendingPixNotice());
  await page.locator('#pendingPixNotice').waitFor({state:'visible'});
  assert.match(await page.locator('#pendingPixNotice').textContent(),/Pagamento confirmado/,'late payment remains claimable');
  await page.setViewportSize({width:390,height:850});
  await page.screenshot({path:path.resolve(__dirname,'../.test-runs/home-polish.png')});
  console.log('PASS HOME: centered header 320–1280px, 50% OFF, derivative loops, offscreen pause, hidden replay, compact/dismissible/30-minute notice, late paid claim preserved');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
  if(browser)await browser.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await db.closeDb();
  for(const ext of ['.webm','.jpg'])fs.rmSync(fixture+ext,{force:true});
});
