const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/never', TEST_DATABASE_SCHEMA: '' };
function run(code) { return spawnSync(process.execPath, ['-e',code], {cwd:path.join(__dirname,'..'),env,encoding:'utf8'}); }
let result = run("require('./tests/sqlite-env'); if(require('./db/database').driver!=='sqlite')throw Error('wrong driver')");
assert.equal(result.status, 0);
result = run("require('./db/postgres').getDb().then(db=>db.get('SELECT 1')).catch(e=>{console.error(e.message);process.exitCode=1})");
assert.notEqual(result.status, 0); assert.match(result.stderr, /ABORT.*isolated/);
result = run("require('./test-suite')");
assert.notEqual(result.status, 0); assert.match(result.stderr, /ABORT/);
console.log('PASS: poisoned environment cannot select PostgreSQL in SQLite tests; unisolated PostgreSQL aborts before connection');
