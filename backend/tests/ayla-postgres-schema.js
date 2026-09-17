// In-memory PostgreSQL verifies real search_path behavior; no external service.
const assert=require('node:assert/strict'),{PGlite}=require('@electric-sql/pglite');
const engine=new PGlite();
class Pool {
 on(){}
 async query(sql,values=[]){const r=values.length?await engine.query(sql,values):(await engine.exec(sql)).at(-1);return {rows:r?.rows||[],rowCount:r?.affectedRows??r?.rows?.length??0};}
 async connect(){return {query:Pool.prototype.query.bind(this),release(){}};}
 async end(){}
}
Object.defineProperty(require('pg'),'Pool',{value:Pool});
Object.assign(process.env,{NODE_ENV:'production',APP_ENV:'production',DATABASE_SCHEMA:'ayla',DATABASE_URL:'postgresql://test:test@localhost/test'});
const db=require('../db/postgres');
(async()=>{
 await engine.exec('CREATE SCHEMA ayla; CREATE SCHEMA staging_ayla_preview; CREATE TABLE public.sentinel(id integer); INSERT INTO public.sentinel VALUES (7)');
 await db.initDb();
 assert.equal((await engine.query("SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='public' AND table_name='orders'")).rows[0].n,0);
 await db.transaction(async d=>{assert.equal((await d.get('SELECT current_schema() AS name')).name,'ayla');});
 assert.equal((await engine.query('SELECT id FROM public.sentinel')).rows[0].id,7);
 await db.closeDb();process.env.APP_ENV='staging';process.env.STAGING_DATABASE_SCHEMA='staging_ayla_preview';
 await db.initDb();await db.transaction(async d=>{assert.equal((await d.get('SELECT current_schema() AS name')).name,'staging_ayla_preview');});
 assert.equal((await engine.query("SELECT count(*) AS n FROM information_schema.tables WHERE table_name='orders' AND table_schema IN ('ayla','staging_ayla_preview')")).rows[0].n,2);
 console.log('PASS Ayla PostgreSQL: own production/Preview schemas, transaction search_path, no tables or mutation in public');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await db.closeDb();await engine.close();});
