// Explicit real Auth check; no payment and no outbound email.
const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const env=require('dotenv').parse(fs.readFileSync('.env'));
const {Pool}=require('pg'),{chromium}=require('../.test-runs/browser/node_modules/playwright');
const origin=process.env.TEST_RECOVERY_URL;
if(!origin||new URL(origin).protocol!=='https:'||!/^privacy-ayla(?:-[a-z0-9-]+)?\.vercel\.app$/.test(new URL(origin).hostname))throw Error('Explicit official or Preview URL required');
const schema=origin==='https://privacy-ayla.vercel.app'?'ayla':'staging_ayla_preview';
const pool=new Pool({connectionString:env.DATABASE_URL,ssl:{rejectUnauthorized:false},max:1});
let user,browser,step='create fixture';
async function auth(route,body,method='POST'){
 const key=env.SUPABASE_SERVICE_ROLE_KEY;
 const r=await fetch(env.SUPABASE_URL+'/auth/v1/'+route,{method,headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 if(!r.ok)throw Error('Auth HTTP '+r.status);return r.json();
}
(async()=>{
 const email='privacy-recovery-'+crypto.randomUUID()+'@example.com',password=crypto.randomBytes(24).toString('base64url'),next=crypto.randomBytes(24).toString('base64url');
 user=await auth('admin/users',{email,password,email_confirm:true});
 await pool.query('INSERT INTO '+schema+'.buyer_accounts(user_id,email,phone) VALUES($1,$2,$3)',[user.id,email,'5511999990000']);
 const destination=origin+'/redefinir-senha';
 const link=await auth('admin/generate_link?redirect_to='+encodeURIComponent(destination),{type:'recovery',email});
 assert.equal(new URL(link.action_link).searchParams.get('redirect_to'),destination);
 step='follow recovery link';
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const page=await browser.newPage({viewport:{width:390,height:850}});page.setDefaultTimeout(60000);
 await page.goto(link.action_link);await page.waitForURL(origin+'/redefinir-senha*');
 await page.getByRole('button',{name:'Salvar nova senha',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>location.hash),'','recovery token removed from visible URL');
 step='reset password';
 await page.locator('[name=password]').fill(next);await page.locator('[name=confirmPassword]').fill(next);await page.locator('#submit').click();await page.waitForURL(origin+'/login');
 const old=await page.request.post(origin+'/api/buyer/account/login',{headers:{Origin:origin},data:{email,password}});assert.equal(old.status(),400);
 step='login after recovery';
 await page.locator('[name=email]').fill(email);await page.locator('[name=password]').fill(next);await page.locator('#submit').click();await page.waitForURL(origin+'/meu-acesso');
 await page.getByText('Sair da conta',{exact:true}).waitFor();
 console.log('PASS real recovery browser: '+origin+'; redirect, form, new password, old password rejected, BUYER login; no email sent');
})().catch(e=>{console.error('Recovery failed at '+step+': '+e.name);process.exitCode=1}).finally(async()=>{
 if(browser)await browser.close();
 if(user){await pool.query('DELETE FROM '+schema+'.buyer_account_sessions WHERE user_id=$1',[user.id]);await pool.query('DELETE FROM '+schema+'.buyer_accounts WHERE user_id=$1',[user.id]);await auth('admin/users/'+user.id,null,'DELETE');}
 await pool.end();
});
