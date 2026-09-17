require('./sqlite-env');
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../../api/index.js'),'utf8');
function entry(env){const context={process:{env},module:{exports:{}},require:()=>({app(){},ready:async()=>{}})};vm.runInNewContext(source,context);return env;}
const preview=entry({VERCEL_ENV:'preview',VERCEL_URL:'privacy-ayla-fixture.vercel.app',PUBLIC_APP_URL:'https://old.invalid'});
assert.equal(preview.PUBLIC_APP_URL,'https://privacy-ayla-fixture.vercel.app');
assert.equal(preview.ADMIN_ORIGIN,preview.PUBLIC_APP_URL);
assert.equal(entry({VERCEL_ENV:'production',PUBLIC_APP_URL:'https://privacy-ayla.vercel.app'}).PUBLIC_APP_URL,'https://privacy-ayla.vercel.app');
assert.throws(()=>entry({VERCEL_ENV:'preview',VERCEL_URL:'evil.example'}));
(async()=>{
  process.env.APP_ENV='staging';process.env.DATABASE_URL='fixture';
  const calls=[];
  const db={get:async(sql,...params)=>{calls.push(sql);return sql.includes('ayla.vip_posts')&&params[0]==='ayla/posts/production.jpg'?{used:1}:undefined;}};
  assert.equal(await require('../services/media-cleanup').shared(db,'ayla/posts/production.jpg'),true);
  assert.equal(calls.length,1,'production reference prevents deletion before preview checks');
  assert.equal(await require('../services/media-cleanup').shared(db,'ayla/posts/preview-only.jpg'),false);
  console.log('PASS consolidation: trusted Preview origin, Production unchanged, shared Storage deletion protected');
})().catch(e=>{console.error(e);process.exitCode=1});
