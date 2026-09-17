require('./sqlite-env');
const crypto=require('node:crypto'),path=require('node:path'),assert=require('node:assert/strict');
process.env.DATABASE_PATH=path.resolve(__dirname,'../.test-runs/admin-loader-'+crypto.randomUUID()+'.sqlite');
process.env.PAYMENT_PROVIDER='mock';
const {app}=require('../server'),database=require('../db/database');
const {chromium}=require('../.test-runs/browser/node_modules/playwright');
let browser,server;
(async()=>{
 await database.initDb();server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 for(const route of ['/','/vip'])for(const admin of [false,true]){
  const page=await browser.newPage(),requests=[];page.on('request',r=>requests.push(new URL(r.url()).pathname));
  // UI contract only: real admin authorization is covered by tests/admin-mode.js.
  await page.route('**/api/admin/me',r=>r.fulfill({json:{admin,csrf:admin?'isolated-csrf':undefined,email:admin?'ui-test@example.invalid':undefined}}));
  await page.route('**/api/admin/session',r=>r.fulfill({json:{uploadMaxBytes:100000,storage:'supabase'}}));
  await page.route('**/api/admin/posts',r=>r.fulfill({json:{posts:[]}}));
  await page.goto('http://127.0.0.1:'+server.address().port+route);
  await page.waitForTimeout(1500);
  assert.equal(requests.filter(r=>r==='/api/admin/me').length,1);
  assert.equal(requests.includes('/admin-mode.js'),admin);
  assert.equal(requests.includes('/admin-mode.css'),admin);
  console.log('PASS conditional admin UI',route,admin?'admin loads editor once':'visitor does not download editor');await page.close();
 }
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));await database.closeDb();});
