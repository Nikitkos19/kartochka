import {readFileSync,writeFileSync,copyFileSync,renameSync,unlinkSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=dirname(fileURLToPath(import.meta.url));
const target=join(root,'server.mjs');
let source=readFileSync(target,'utf8');
const declaration="const adminTestTopup = process.env.ADMIN_TEST_TOPUP === 'true';";
const oldGuard="if(!demoPayments) return json(res,503,{error:'Тестовое пополнение выключено.'});";
const newGuard="if(!demoPayments && !(adminTestTopup && u.role==='admin')) return json(res,adminTestTopup?403:503,{error:adminTestTopup?'Тестовые токены на хостинге может начислять только администратор.':'Тестовое пополнение выключено.'});";
if(source.includes(declaration)&&source.includes(newGuard)){console.log('Patch already applied. Set ADMIN_TEST_TOPUP=true in Render Environment and redeploy.');process.exit(0)}
const original="const demoPayments = process.env.DEMO_PAYMENTS === 'true' && !secureCookies;";
if(source.includes('ADMIN_TEST_TOPUP')||source.split(original).length!==2||source.split(oldGuard).length!==2)throw Error('Unexpected server version. No changes made; merge the patch manually.');
const eol=source.includes('\r\n')?'\r\n':'\n';
source=source.replace(original,original+eol+declaration).replace(oldGuard,newGuard).replace('ok:true,demoPayments,aiConfigured:','ok:true,demoPayments,adminTestTopup,aiConfigured:');
const temporary=join(root,'.admin-topup-'+randomUUID()+'.mjs');
writeFileSync(temporary,source,{encoding:'utf8',flag:'wx'});
const check=spawnSync(process.execPath,['--check',temporary],{windowsHide:true,stdio:'pipe'});
if(check.status!==0){unlinkSync(temporary);throw Error('Syntax check failed. Original server unchanged.')}
const backup=target+'.before-admin-topup-'+Date.now()+'.bak';
copyFileSync(target,backup);
renameSync(temporary,target);
console.log('Patched server.mjs; original saved as '+backup);
console.log('Keep NODE_ENV=production. Set ADMIN_TEST_TOPUP=true in Render Environment, then deploy/restart. Only an authenticated admin can top up their own wallet.');
