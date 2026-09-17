// Explicit local operator command. Always Preview; no production flag accepted.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
if(process.argv.length>2)throw Error('This command accepts no flags and deploys Preview only.');
const binding=path.join(root,'.vercel/project.json');
if(!fs.existsSync(binding))throw Error('First link a NEW Vercel project named privacy-ayla. See DEPLOY.md.');
const project=JSON.parse(fs.readFileSync(binding,'utf8'));
if(project.projectName!=='privacy-ayla')throw Error('Deployment blocked: expected independent privacy-ayla binding.');
const check=spawnSync(process.execPath,['backend/tests/check.js'],{cwd:root,stdio:'inherit'});
if(check.status!==0)process.exit(1);
const win=process.platform==='win32',args=['--yes','vercel@latest','deploy','--yes'];
const result=spawnSync(win?'npx.cmd':'npx',win?args.map(a=>`"${a}"`):args,{cwd:root,stdio:'inherit',shell:win});
process.exit(result.status??1);
