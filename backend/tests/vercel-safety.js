require('./sqlite-env');
process.env.VERCEL='1';process.env.PAYMENT_PROVIDER='mock';
const assert=require('node:assert/strict');
const {app}=require('../server');
const server=app.listen(0,'127.0.0.1',async()=>{
 try {
  const base='http://127.0.0.1:'+server.address().port;
  for(const route of ['/api/dev/orders/unknown/pay','/backend/server.js','/backend/.env','/backend.env']) {
   const response=await fetch(base+route,{method:route.includes('/dev/')?'POST':'GET'});
   assert.equal(response.status,404,route);
  }
  console.log('PASS Vercel: mock approval route absent; source and env not served');
 }catch(e){console.error(e);process.exitCode=1;}finally{server.close();}
});
