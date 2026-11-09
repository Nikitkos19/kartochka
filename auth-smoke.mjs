import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import Database from 'better-sqlite3';
import { moderationPolicyVersion } from './product-moderation.mjs';
import { createServer as createHttpServer } from 'node:http';

const appDir = dirname(fileURLToPath(import.meta.url));
const sandbox = await mkdtemp(join(tmpdir(), 'catalog-auth-smoke-'));
const port = await new Promise((resolvePort, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const selected = probe.address().port; probe.close(() => resolvePort(selected)); });
});
const base = `http://127.0.0.1:${port}`;
const password = randomBytes(20).toString('base64url');
const email = 'registration-check@example.invalid';
const adminEmail = 'admin-check@example.invalid';
const photoBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64');
const photo = 'data:image/png;base64,' + photoBytes.toString('base64');
let child;
let mockProvider;
async function stop() {
  if (child && child.exitCode === null) await new Promise(resolveExit => { child.once('exit', resolveExit); child.kill(); });
}
async function start(extraEnv = {}) {
  let log = '';
  child = spawn(process.execPath, [join(appDir, 'server.mjs')], {
    cwd: sandbox,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: join(sandbox, 'data'), NODE_ENV: 'test', DEMO_PAYMENTS: 'true', AI_API_KEY: '', AI_IMAGE_MODEL: '', AI_MODERATION_MODEL:'vision-test', ADMIN_EMAIL: adminEmail, ADMIN_PASSWORD: password, ACCESS_EMAILS: '', REGISTRATION_OPEN: 'true', ...extraEnv },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', data => { log += data; });
  child.stderr.on('data', data => { log += data; });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error('Server exited during startup: ' + log);
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw Error('Startup timed out: ' + log);
}
async function request(path, { method = 'GET', body, cookie, origin, forwardedProto } = {}) {
  if (path === '/api/generate-image' && body) body = { photo, ...body };
  const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}), ...(forwardedProto ? { 'X-Forwarded-Proto': forwardedProto } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, headers: response.headers, data: await response.json() };
}
const session = response => response.headers.get('set-cookie')?.split(';')[0];
try {
  for (const name of ['index.html', 'app.js', 'style.css']) await copyFile(join(appDir, name), join(sandbox, name));
  await start();
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await request('/api/me')).data.user, null);
  assert.equal((await request('/api/me',{cookie:'catalog_session=%'})).data.user,null);
  assert.equal((await fetch(base+'/%E0%A4%A')).status,400);
  assert.equal((await request('/api/health')).data.ok,true);
  assert.equal((await request('/api/admin/moderation')).status,401);
  assert.equal((await request('/api/wallet')).status, 401);
  assert.equal((await request('/api/auth/register', { method: 'POST', body: { email, password: 'short' } })).status, 400);
  const registered = await request('/api/auth/register', { method: 'POST', body: { email, password }, origin: base });
  assert.equal(registered.status, 201, JSON.stringify(registered.data));
  assert.equal(registered.data.user.role, 'user');
  assert.match(registered.headers.get('set-cookie'), /HttpOnly/);
  let cookie = session(registered);
  assert.equal((await request('/api/me', { cookie })).data.user.email, email);
  assert.equal((await request('/api/auth/register', { method: 'POST', body: { email, password } })).status, 409);
  assert.equal((await request('/api/admin/overview', { cookie })).status, 403);
  assert.equal((await request('/api/admin/moderation', { cookie })).status,403);
  assert.equal((await request('/api/test/topup', { method: 'POST', cookie, body: { tokens: 10 }, origin: 'https://other.example' })).status, 403);
  const topup = await request('/api/test/topup', { method: 'POST', cookie, body: { tokens: 10 } });
  assert.equal(topup.status, 200);
  assert.equal(topup.data.tokens, 10);
  const customPrompt = 'Тёплый дневной свет, бежевый фон.\nБез лишних деталей.';
  const workspace = { products: [], orders: [], style: 'minimal', pages: ['main'], customPrompt, settings: {} };
  assert.equal((await request('/api/workspace', { method: 'PUT', cookie, body: { workspace } })).status, 200);
  assert.deepEqual((await request('/api/workspace', { cookie })).data.workspace.pages, ['main']);
  assert.equal((await request('/api/workspace', { cookie })).data.workspace.customPrompt, customPrompt);
  assert.equal((await request('/api/workspace', { method: 'PUT', cookie, body: { workspace: { ...workspace, customPrompt: 'x'.repeat(2001) } } })).status, 400);
  assert.equal((await request('/api/generate-image', { method: 'POST', cookie, body: { name: 'Smoke product', page: 'main', customPrompt: 'x'.repeat(2001) } })).status, 400);
  assert.equal((await request('/api/generate-image', { method: 'POST', cookie, body: { name: 'Smoke product', page: 'main', customPrompt: { text: 'invalid type' } } })).status, 400);
  assert.equal((await request('/api/generate-image', { method: 'POST', cookie, body: { name: 'Smoke product', page: 'main', photo: null } })).status, 400);
  assert.equal((await request('/api/generate-image', { method: 'POST', cookie, body: { name: 'Smoke product', page: 'main', photo: 'data:image/png;base64,dGVzdA==' } })).status, 400);
  assert.equal((await request('/api/wallet', { cookie })).data.tokens, 10);
  const generated = await request('/api/generate-image', { method: 'POST', cookie, body: { name: 'Smoke product', page: 'main' } });
  assert.equal(generated.status, 503);
  assert.equal(generated.data.tokens, 10);
  assert.equal((await request('/api/wallet', { cookie })).data.tokens, 10);
  assert.equal((await request('/api/auth/logout', { method: 'POST', cookie, body: {} })).status, 200);
  assert.equal((await request('/api/me', { cookie })).data.user, null);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { email, password: 'wrong-password' } })).status, 401);
  const login = await request('/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(login.status, 200);
  cookie = session(login);
  const admin = await request('/api/auth/login', { method: 'POST', body: { email: adminEmail, password } });
  assert.equal(admin.status, 200);
  const overview = await request('/api/admin/overview', { cookie: session(admin) });
  assert.equal(overview.status, 200, JSON.stringify(overview.data));
  assert.equal(overview.data.users, 1);
  for (const path of ['/.env', '/server.mjs', '/product-moderation-policy.txt','/product-moderation.mjs', '/.data/catalog.sqlite3']) assert.equal((await fetch(base + path)).status, 404);
  await stop();
  await start();
  assert.equal((await request('/api/me', { cookie })).data.user.email, email);
  assert.equal((await request('/api/wallet', { cookie })).data.tokens, 10);
  assert.deepEqual((await request('/api/workspace', { cookie })).data.workspace.pages, ['main']);
  assert.equal((await request('/api/workspace', { cookie })).data.workspace.customPrompt, customPrompt);
  const outsiderEmail = 'not-invited@example.invalid';
  const outsider = await request('/api/auth/register', { method: 'POST', body: { email: outsiderEmail, password } });
  assert.equal(outsider.status, 201);
  const outsiderCookie = session(outsider);
  await stop();
  await start({ ACCESS_EMAILS: `${email},${adminEmail}` });
  const health = (await request('/api/health')).data;
  assert.equal(health.privateAccess, true);
  assert.equal(health.registrationOpen, false);
  assert.equal((await request('/api/auth/register', { method: 'POST', body: { email: 'new@example.invalid', password } })).status, 403);
  assert.equal((await request('/api/me', { cookie: outsiderCookie })).data.user, null);
  assert.equal((await request('/api/wallet', { cookie: outsiderCookie })).status, 401);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: outsiderEmail, password } })).status, 401);
  const privateLogin = await request('/api/auth/login', { method: 'POST', body: { email, password }, forwardedProto: 'https' });
  assert.equal(privateLogin.status, 200);
  assert.match(privateLogin.headers.get('set-cookie'), /; Secure/);
  assert.equal((await request('/api/admin/overview', { cookie: session(privateLogin) })).status, 403);
  assert.equal((await request('/api/admin/overview', { cookie: session(admin) })).status, 200);
  const seenRequests = [], moderationRequests=[];
  let moderationMode='ALLOW';
  mockProvider = createHttpServer(async (req, res) => {
    const chunks=[];
    for await (const chunk of req) chunks.push(chunk);
    const raw=Buffer.concat(chunks);
    if(req.url==='/chat/completions'){
      const data=JSON.parse(raw),request=JSON.parse(data.messages[1].content[0].text);
      moderationRequests.push({stage:request.stage,body:data});
      let state=moderationMode.startsWith('INPUT_')&&request.stage==='input'?moderationMode.slice(6):moderationMode.startsWith('OUTPUT_')&&request.stage==='output'?moderationMode.slice(7):'ALLOW';
      if(state==='ERROR'){res.writeHead(500);res.end('{}');return}
      const cats=state==='ALLOW'?[]:['WEAPONS'];
      const result={decision:state,categories:cats,items:[{input_id:'image_1',decision:state,categories:cats,evidence:'Fixture photo'},{input_id:'request',decision:'ALLOW',categories:[],evidence:'Fixture request'}],reason:'Fixture decision',user_message:'Fixture message'};
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:state==='MALFORMED'?'{}':JSON.stringify(result)}}]}));return;
    }
    assert.equal(req.url,'/images/edits');
    const decoded=await new Request('http://mock/images/edits',{method:'POST',headers:{'Content-Type':req.headers['content-type']},body:raw}).formData();
    const image=decoded.get('image');
    seenRequests.push({url:req.url,method:req.method,body:{model:decoded.get('model'),prompt:decoded.get('prompt'),n:decoded.get('n')},image:Buffer.from(await image.arrayBuffer()),mime:image.type,contentLength:Number(req.headers['content-length']),actualLength:raw.length});
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=' }] }));
  });
  await new Promise(resolveListen => mockProvider.listen(0, '127.0.0.1', resolveListen));
  await stop();
  await start({ ACCESS_EMAILS: `${email},${adminEmail}`, AI_API_BASE_URL: `http://127.0.0.1:${mockProvider.address().port}`, AI_API_KEY: 'test-placeholder-not-a-real-key', AI_IMAGE_MODEL: 'mock-image' });
  const promptCookie = session(privateLogin);
  const customized = await request('/api/generate-image', { method: 'POST', cookie: promptCookie, body: { name: 'Smoke product', sku:'CHAIR-1',material:'Дерево',dimensions:'60 × 40 см',description:'Стул с мягким сиденьем',style:'bold',color:'#123456',features:{dimensions:false,material:true},page: 'main', customPrompt } });
  assert.equal(customized.status, 200, JSON.stringify(customized.data));
  assert.equal(customized.data.tokens, 9);
  assert.equal(seenRequests.length, 1);
  assert.equal(seenRequests[0].url, '/images/edits');
  assert.deepEqual(seenRequests[0].image, photoBytes);
  assert.equal(seenRequests[0].mime, 'image/png');
  assert.equal(seenRequests[0].contentLength, seenRequests[0].actualLength);
  assert.equal(seenRequests[0].body.model, 'mock-image');
  assert.ok(seenRequests[0].body.prompt.replace(/\r\n/g,'\n').includes(customPrompt));
  for (const value of ['ПОЛНОСТЬЮ ГОТОВУЮ','CHAIR-1','Дерево','60 × 40 см','Стул с мягким сиденьем','#123456','Яркий стиль']) assert.ok(seenRequests[0].body.prompt.includes(value));
  assert.ok(!seenRequests[0].body.prompt.includes('BACKGROUND only'));
  assert.equal(customized.data.renderMode, 'full-card');
  const asset=await fetch(base+`/api/generations/${customized.data.generationId}/image`,{headers:{Cookie:promptCookie}});
  assert.equal(asset.status,200);
  assert.equal(asset.headers.get('X-Catalog-Render-Mode'),'full-card');
  assert.deepEqual(Buffer.from(await asset.arrayBuffer()),photoBytes);
  const defaultPrompt = await request('/api/generate-image', { method: 'POST', cookie: promptCookie, body: { name: 'Smoke product', page: 'material', customPrompt: '   ' } });
  assert.equal(defaultPrompt.status, 200);
  assert.equal(defaultPrompt.data.tokens, 8);
  assert.equal(seenRequests.length, 2);
  assert.ok(!seenRequests[1].body.prompt.includes('Личные пожелания клиента'));
  assert.deepEqual(moderationRequests.map(x=>x.stage),['input','output','input','output']);
  assert.ok(moderationRequests.every(x=>x.body.model==='vision-test'&&x.body.messages[0].role==='system'&&x.body.messages[0].content.includes('OFF_TOPIC')));
  assert.equal(moderationRequests[0].body.messages[1].content.at(-1).image_url.url,photo);
  assert.equal(moderationRequests[1].body.messages[1].content.at(-1).image_url.url,customized.data.imageData);
  for(const mode of ['INPUT_REJECT','INPUT_REVIEW','INPUT_ERROR','INPUT_MALFORMED','OUTPUT_REJECT','OUTPUT_REVIEW','OUTPUT_ERROR','OUTPUT_MALFORMED']){
    moderationMode=mode;
    const beforeImages=seenRequests.length;
    const blocked=await request('/api/generate-image',{method:'POST',cookie:promptCookie,body:{name:'Moderation fixture',page:'main'}});
    assert.equal(blocked.status,mode.includes('ERROR')||mode.includes('MALFORMED')?503:422,JSON.stringify(blocked.data));
    assert.equal(blocked.data.tokens,8);
    assert.equal((await request('/api/wallet',{cookie:promptCookie})).data.tokens,8);
    assert.equal(seenRequests.length,beforeImages+(mode.startsWith('OUTPUT_')?1:0),'Rejected input must never reach generator');
    assert.ok(blocked.data.requestId&&blocked.data.moderationCode);
    assert.equal(blocked.data.moderation.stage,mode.startsWith('OUTPUT_')?'output':'input');
    assert.equal(blocked.data.moderation.policyVersion,moderationPolicyVersion);
    if(!mode.includes('ERROR')&&!mode.includes('MALFORMED'))assert.deepEqual(blocked.data.moderation.categories,['WEAPONS']);
  }
  const checks=new Database(join(sandbox,'data','catalog.sqlite3'));
  assert.equal(checks.prepare('SELECT count(*) n FROM generation_assets').get().n,2,'Rejected output must not be persisted');
  assert.equal(checks.prepare("SELECT count(*) n FROM generations WHERE status='processing'").get().n,0);
  assert.equal(checks.prepare("SELECT count(*) n FROM moderation_checks WHERE decision IN ('ERROR','REJECT','REVIEW')").get().n,8);
  checks.prepare('UPDATE generation_assets SET moderation_policy=? WHERE generation_id=?').run('',customized.data.generationId);
  const legacy=await fetch(base+`/api/generations/${customized.data.generationId}/image`,{headers:{Cookie:promptCookie}});
  assert.equal(legacy.status,423,'Images without current moderation approval must not be delivered');
  checks.prepare('UPDATE generation_assets SET moderation_policy=? WHERE generation_id=?').run(moderationPolicyVersion,customized.data.generationId);
  for(const version of ['product-v1-ae67d6ff5847','product-v1-dfd5fd26b3fa']){
    checks.prepare('UPDATE generation_assets SET moderation_policy=? WHERE generation_id=?').run(version,customized.data.generationId);
    const oldApproved=await fetch(base+`/api/generations/${customized.data.generationId}/image`,{headers:{Cookie:promptCookie}});
    assert.equal(oldApproved.status,200,'Known equivalent policy approvals remain valid');
  }
  checks.prepare('UPDATE generation_assets SET moderation_policy=? WHERE generation_id=?').run(moderationPolicyVersion,customized.data.generationId);
  checks.close();
  const log=await request('/api/admin/moderation',{cookie:session(admin)});
  assert.equal(log.status,200,JSON.stringify(log.data));
  assert.ok(log.data.checks.some(c=>c.decision==='REJECT'&&c.reason==='Fixture decision'&&c.details.length===2));
  assert.ok(log.data.checks.every(c=>!Object.hasOwn(c,'image')&&!Object.hasOwn(c,'email')&&!Object.hasOwn(c,'prompt')));
  await stop();
  await start({ACCESS_EMAILS:`${email},${adminEmail}`});
  const reloaded=await fetch(base+`/api/generations/${customized.data.generationId}/image`,{headers:{Cookie:promptCookie}});
  assert.equal(reloaded.headers.get('X-Catalog-Render-Mode'),'full-card');
  assert.deepEqual(Buffer.from(await reloaded.arrayBuffer()),photoBytes);
  console.log('PASS: mandatory input/output moderation, rejection/error refunds, no rejected assets, legacy delivery gate, authentication/private access, photo validation before charging, prompt persistence, multipart photo+all settings to mock editing API, explicit content length, raw final image bytes and render mode after restart. No paid AI calls.');
} finally {
  await stop();
  if (mockProvider) await new Promise(resolveClose => mockProvider.close(resolveClose));
  if (resolve(dirname(sandbox)) === resolve(tmpdir()) && basename(sandbox).startsWith('catalog-auth-smoke-')) await rm(sandbox, { recursive: true, force: true });
}
