import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { normalizeCustomPrompt, validateCardRequest, generateProductCard } from './image-generation.mjs';
import { moderateProductImage, moderationPolicyVersion } from './product-moderation.mjs';

const scrypt = promisify(scryptCallback);
const root = resolve('.');
if (existsSync(resolve(root, '.env'))) {
  for (const line of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const secureCookies = process.env.NODE_ENV === 'production';
const demoPayments = process.env.DEMO_PAYMENTS === 'true' && !secureCookies;
const adminTestTopup = process.env.ADMIN_TEST_TOPUP === 'true';
const accessEmails = new Set((process.env.ACCESS_EMAILS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
const privateAccess = accessEmails.size > 0;
const registrationOpen = !privateAccess && process.env.REGISTRATION_OPEN !== 'false';
const emailAllowed = email => !privateAccess || accessEmails.has(String(email).toLowerCase());
const base = (process.env.AI_API_BASE_URL || 'https://apimira.com/v1').replace(/\/+$/, '');
const apiKey = process.env.AI_API_KEY || '';
const model = process.env.AI_IMAGE_MODEL || '';
const moderationModel = process.env.AI_MODERATION_MODEL || 'openai/gpt-5.4-mini';
const dataDir = resolve(process.env.DATA_DIR || '.data');
await mkdir(dataDir, { recursive: true });
const db = new Database(resolve(dataDir, 'catalog.sqlite3'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS wallets (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, tokens INTEGER NOT NULL DEFAULT 0 CHECK(tokens >= 0));
CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), delta INTEGER NOT NULL, kind TEXT NOT NULL, description TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS generations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), page TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS workspaces (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS generation_assets (generation_id TEXT PRIMARY KEY REFERENCES generations(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, file_path TEXT NOT NULL, mime_type TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS moderation_checks (request_id TEXT NOT NULL, stage TEXT NOT NULL, policy_version TEXT NOT NULL, decision TEXT NOT NULL, categories_json TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(request_id,stage));
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS ledger_user_idx ON ledger(user_id, created_at);
CREATE INDEX IF NOT EXISTS generations_user_idx ON generations(user_id, created_at);
`);
if (!db.prepare('PRAGMA table_info(generation_assets)').all().some(column => column.name === 'render_mode')) db.exec("ALTER TABLE generation_assets ADD COLUMN render_mode TEXT NOT NULL DEFAULT 'background'");

if (!db.prepare('PRAGMA table_info(generation_assets)').all().some(column => column.name === 'moderation_policy')) db.exec("ALTER TABLE generation_assets ADD COLUMN moderation_policy TEXT NOT NULL DEFAULT ''");
function auditModeration(requestId) {
  return entry => db.prepare('INSERT INTO moderation_checks(request_id,stage,policy_version,decision,categories_json,reason,created_at) VALUES(?,?,?,?,?,?,?)').run(requestId,entry.stage,entry.policyVersion,entry.decision,JSON.stringify(entry.categories),entry.reason,new Date().toISOString());
}
const moderationConfig = { base, apiKey, model:moderationModel };

const nowIso = () => new Date().toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
const loginBuckets = new Map();
const generationBuckets = new Map();
const allowedPages = new Set(['main','dimensions','material','benefits','composition','design','convenience']);
function json(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(data));
}
function readBody(req, max = 40_000) {
  return new Promise((resolveBody, reject) => {
    let raw = '', failed = false;
    req.on('data', chunk => { if (failed) return; raw += chunk; if (raw.length > max) { failed = true; reject(Object.assign(new Error('Запрос слишком большой.'), { status: 413 })); } });
    req.on('end', () => { if (failed) return; try { resolveBody(JSON.parse(raw || '{}')); } catch { reject(Object.assign(new Error('Некорректный JSON.'), { status: 400 })); } });
    req.on('error', reject);
  });
}
function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(v => v.trim()).filter(Boolean).map(v => { const i = v.indexOf('='); return [v.slice(0,i), decodeURIComponent(v.slice(i+1))]; }));
}
function requestIsSecure(req) {
  return secureCookies || Boolean(req.socket.encrypted) || (['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && req.headers['x-forwarded-proto'] === 'https');
}
function cookieHeader(value, maxAge, secure = secureCookies) {
  return `catalog_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
function currentUser(req) {
  const token = parseCookies(req.headers.cookie).catalog_session;
  if (!token) return null;
  const session = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash=?').get(hash(token));
  if (!session || session.expires_at < Date.now()) { if (session) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token)); return null; }
  const user = db.prepare('SELECT id,email,role,active FROM users WHERE id=?').get(session.user_id);
  return user?.active && emailAllowed(user.email) ? user : null;
}
function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) { json(res, 401, { error: 'Войдите в аккаунт, чтобы продолжить.' }); return null; }
  return user;
}
function requireAdmin(req, res) {
  const user = requireUser(req, res);
  if (user && user.role !== 'admin') { json(res, 403, { error: 'Недостаточно прав.' }); return null; }
  return user;
}
function wallet(userId) { return db.prepare('SELECT tokens FROM wallets WHERE user_id=?').get(userId)?.tokens ?? 0; }
function userPayload(user) { return { id:user.id, email:user.email, role:user.role, tokens:wallet(user.id) }; }
async function passwordHash(password, salt) { return (await scrypt(password, Buffer.from(salt, 'hex'), 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString('hex'); }
async function createSession(res, userId) {
  const token = randomBytes(32).toString('base64url'), expires = Date.now() + 30*24*60*60*1000;
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash(token), userId, expires);
  return cookieHeader(token, 30*24*60*60, requestIsSecure(res.req));
}
function rateLimit(map, key, limit, interval) {
  const now = Date.now(), hits = (map.get(key)||[]).filter(t=>now-t<interval);
  if (hits.length >= limit) return false;
  hits.push(now); map.set(key,hits); return true;
}
function reserveToken(userId, page) {
  const id = randomUUID(), date = nowIso();
  const tx = db.transaction(() => {
    const changed = db.prepare('UPDATE wallets SET tokens=tokens-1 WHERE user_id=? AND tokens>=1').run(userId).changes;
    if (!changed) throw Object.assign(new Error('Недостаточно токенов. Пополните баланс.'), { status: 402 });
    db.prepare('INSERT INTO generations(id,user_id,page,status,created_at) VALUES(?,?,? ,?,?)').run(id,userId,page,'processing',date);
    db.prepare('INSERT INTO ledger(id,user_id,delta,kind,description,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(),userId,-1,'generation_reserved',`Генерация страницы: ${page}`,date);
  });
  tx(); return id;
}
function refundToken(generationId,userId,error) {
  const date = nowIso();
  db.transaction(() => {
    db.prepare('UPDATE wallets SET tokens=tokens+1 WHERE user_id=?').run(userId);
    db.prepare('INSERT INTO ledger(id,user_id,delta,kind,description,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(),userId,1,'generation_refund','Возврат токена: генерация не выполнена',date);
    db.prepare('UPDATE generations SET status=?,finished_at=?,error=? WHERE id=? AND user_id=?').run('failed',date,String(error).slice(0,300),generationId,userId);
  })();
}
for (const job of db.prepare('SELECT id,user_id FROM generations WHERE status=?').all('processing')) refundToken(job.id,job.user_id,'Сервер перезапустился во время генерации');
async function generateImage(body) { return generateProductCard(body, { base, apiKey, model }); }

const adminEmail=(process.env.ADMIN_EMAIL||'').trim().toLowerCase();
const adminPassword=process.env.ADMIN_PASSWORD||'';
if(adminEmail && adminPassword && !db.prepare('SELECT id FROM users WHERE email=?').get(adminEmail)) {
  const salt=randomBytes(16).toString('hex');
  const password_hash=await passwordHash(adminPassword,salt);
  const id=randomUUID();
  db.transaction(()=>{db.prepare('INSERT INTO users(id,email,salt,password_hash,role,active,created_at) VALUES(?,?,?,?,?,?,?)').run(id,adminEmail,salt,password_hash,'admin',1,nowIso());db.prepare('INSERT INTO wallets(user_id,tokens) VALUES(?,0)').run(id);})();
  console.log(`Создан администратор ${adminEmail}`);
}
setInterval(()=>db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()),60*60*1000).unref();

const server=createServer(async(req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`), ip=req.socket.remoteAddress||'unknown';
  if(req.method==='GET' && url.pathname==='/api/me') { const u=currentUser(req); return json(res,200,{user:u?userPayload(u):null}); }
  if(req.method==='POST' && !originOk(req)) return json(res,403,{error:'Запрос с чужого сайта отклонён.'});
  if(req.method==='POST' && url.pathname==='/api/auth/register') {
    if(!registrationOpen) return json(res,403,{error:'Регистрация закрыта. Вход только по приглашению.'});
    if(!rateLimit(loginBuckets,ip,8,15*60*1000)) return json(res,429,{error:'Слишком много попыток. Подождите немного.'});
    try {
      const body=await readBody(req,10_000),email=String(body.email||'').trim().toLowerCase(),password=String(body.password||'');
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254) return json(res,400,{error:'Введите корректный email.'});
      if(password.length<10||password.length>128) return json(res,400,{error:'Пароль должен содержать от 10 до 128 символов.'});
      if(db.prepare('SELECT id FROM users WHERE email=?').get(email)) return json(res,409,{error:'Аккаунт с таким email уже существует.'});
      const id=randomUUID(),salt=randomBytes(16).toString('hex'),password_hash=await passwordHash(password,salt);
      db.transaction(()=>{db.prepare('INSERT INTO users(id,email,salt,password_hash,created_at) VALUES(?,?,?,?,?)').run(id,email,salt,password_hash,nowIso());db.prepare('INSERT INTO wallets(user_id,tokens) VALUES(?,0)').run(id);})();
      const user=db.prepare('SELECT id,email,role,active FROM users WHERE id=?').get(id);
      return json(res,201,{user:userPayload(user)},{'Set-Cookie':await createSession(res,id)});
    } catch(e) { return json(res,e.status||500,{error:e.message||'Не удалось создать аккаунт.'}); }
  }
  if(req.method==='POST' && url.pathname==='/api/auth/login') {
    if(!rateLimit(loginBuckets,ip,10,15*60*1000)) return json(res,429,{error:'Слишком много попыток. Подождите немного.'});
    try {
      const body=await readBody(req,10_000),email=String(body.email||'').trim().toLowerCase(),password=String(body.password||''),user=db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email);
      if(!user || !emailAllowed(email)) return json(res,401,{error:'Неверный email или пароль.'});
      const calculated=Buffer.from(await passwordHash(password,user.salt),'hex'),stored=Buffer.from(user.password_hash,'hex');
      if(calculated.length!==stored.length||!timingSafeEqual(calculated,stored)) return json(res,401,{error:'Неверный email или пароль.'});
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      const publicUser={id:user.id,email:user.email,role:user.role,active:user.active};
      return json(res,200,{user:userPayload(publicUser)},{'Set-Cookie':await createSession(res,user.id)});
    } catch(e) { return json(res,e.status||500,{error:e.message||'Не удалось войти.'}); }
  }
  if(req.method==='POST' && url.pathname==='/api/auth/logout') {
    const token=parseCookies(req.headers.cookie).catalog_session;
    if(token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
    return json(res,200,{ok:true},{'Set-Cookie':cookieHeader('',0,requestIsSecure(req))});
  }
    if(req.method==='GET' && url.pathname==='/api/workspace') {
    const u=requireUser(req,res); if(!u)return;
    const row=db.prepare('SELECT data_json,updated_at FROM workspaces WHERE user_id=?').get(u.id);
    return json(res,200,{workspace:row?JSON.parse(row.data_json):null,updatedAt:row?.updated_at||null});
  }
  if(req.method==='PUT' && url.pathname==='/api/workspace') {
    const u=requireUser(req,res); if(!u)return;
    try {
      const body=await readBody(req,8_000_000),w=body.workspace;
      if(!w||!Array.isArray(w.products)||!Array.isArray(w.orders)||w.products.length>30) return json(res,400,{error:'Некорректные данные каталога.'});
      const customPrompt = normalizeCustomPrompt(w.customPrompt);
      for(const p of w.products){if(typeof p.name!=='string'||typeof p.sku!=='string'||p.name.length>120||p.sku.length>100||p.description?.length>3000||p.photo&&!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p.photo))return json(res,400,{error:'Данные товара не прошли проверку.'});}
      const safe={products:w.products,orders:w.orders.slice(0,100),customPrompt,activeOrderId:typeof w.activeOrderId==='string'?w.activeOrderId.slice(0,80):'',style:['minimal','natural','bold'].includes(w.style)?w.style:'minimal',color:/^#[0-9a-f]{6}$/i.test(w.color||'')?w.color:'#087f5b',features:{dimensions:Boolean(w.features?.dimensions),material:Boolean(w.features?.material)},pages:Array.isArray(w.pages)?w.pages.filter(x=>allowedPages.has(x)) : ['main','dimensions','material'],tickets:Array.isArray(w.tickets)?w.tickets.slice(-100):[],settings:{email:u.email,notifications:Boolean(w.settings?.notifications)},paused:false};
      db.prepare('INSERT INTO workspaces(user_id,data_json,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at').run(u.id,JSON.stringify(safe),nowIso());
      return json(res,200,{ok:true});
    }catch(e){return json(res,e.status||500,{error:e.message||'Не удалось сохранить каталог.'});}
  }if(req.method==='GET' && url.pathname==='/api/wallet') {
    const u=requireUser(req,res); if(!u)return;
    return json(res,200,{tokens:wallet(u.id),ledger:db.prepare('SELECT delta,kind,description,created_at FROM ledger WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(u.id)});
  }
  if(req.method==='POST' && url.pathname==='/api/test/topup') {
    const u=requireUser(req,res); if(!u)return;
    if(!demoPayments && !(adminTestTopup && u.role==='admin')) return json(res,adminTestTopup?403:503,{error:adminTestTopup?'Тестовые токены на хостинге может начислять только администратор.':'Тестовое пополнение выключено.'});
    try {
      const body=await readBody(req,5_000),tokens=Number(body.tokens);
      if(![10,50,100].includes(tokens)) return json(res,400,{error:'Выберите пакет из списка.'});
      const date=nowIso();
      db.transaction(()=>{db.prepare('UPDATE wallets SET tokens=tokens+? WHERE user_id=?').run(tokens,u.id);db.prepare('INSERT INTO ledger(id,user_id,delta,kind,description,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(),u.id,tokens,'test_topup',`Тестовое пополнение: ${tokens} токенов`,date);})();
      return json(res,200,{tokens:wallet(u.id),demo:true});
    } catch(e) { return json(res,e.status||500,{error:e.message||'Пополнение не выполнено.'}); }
  }
  if(req.method==='POST' && url.pathname==='/api/generate-image') {
    const u=requireUser(req,res); if(!u)return;
    if(!rateLimit(generationBuckets,u.id,30,60*60*1000)) return json(res,429,{error:'Достигнут часовой лимит генераций. Попробуйте позже.'});
    let body,generationId;
    const requestId=randomUUID(), audit=auditModeration(requestId);
    try {
      body=validateCardRequest(await readBody(req,8_000_000));
      if(!apiKey||!model)throw Object.assign(new Error('Нейросеть не настроена на сервере.'),{status:503});
      if(wallet(u.id)<1)throw Object.assign(new Error('Недостаточно токенов. Пополните баланс.'),{status:402});
      await moderateProductImage(body,`data:${body.image.mime};base64,${body.image.bytes.toString('base64')}`,'input',moderationConfig,audit);
      generationId=reserveToken(u.id,body.page);
    } catch(e) { return json(res,e.status||500,{error:e.message||'Не удалось начать генерацию.',tokens:wallet(u.id),...(e.moderationCode?{moderationCode:e.moderationCode,requestId}:{})}); }
    try {
      const imageData=await generateImage(body);
      await moderateProductImage(body,imageData,'output',moderationConfig,audit);
      const match=imageData.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
      if(!match) throw new Error('Провайдер вернул изображение в неподдерживаемом формате.');
      const extension=match[1]==='image/jpeg'?'jpg':match[1]==='image/webp'?'webp':'png';
      const filePath=resolve(dataDir,'images',`${generationId}.${extension}`);
      await mkdir(resolve(dataDir,'images'),{recursive:true});
      await writeFile(filePath,Buffer.from(match[2],'base64'));
      db.prepare('INSERT INTO generation_assets(generation_id,user_id,file_path,mime_type,render_mode,moderation_policy) VALUES(?,?,?,?,?,?)').run(generationId,u.id,filePath,match[1],'full-card',moderationPolicyVersion);
      db.prepare('UPDATE generations SET status=?,finished_at=? WHERE id=?').run('complete',nowIso(),generationId);
      return json(res,200,{imageData,generationId,renderMode:'full-card',tokens:wallet(u.id)});
    } catch(e) {
      refundToken(generationId,u.id,e.message||'Ошибка генерации');
      return json(res,e.status||502,{error:e.message||'Генерация не выполнена. Токен возвращён.',tokens:wallet(u.id),...(e.moderationCode?{moderationCode:e.moderationCode,requestId}:{})});
    }
  }
    const assetMatch=url.pathname.match(/^\/api\/generations\/([a-f0-9-]+)\/image$/i);
  if(req.method==='GET' && assetMatch) {
    const u=requireUser(req,res); if(!u)return;
    const asset=db.prepare('SELECT file_path,mime_type,render_mode,moderation_policy FROM generation_assets WHERE generation_id=? AND user_id=?').get(assetMatch[1],u.id);
    if(!asset)return json(res,404,{error:'Изображение не найдено.'});
    if(asset.moderation_policy!==moderationPolicyVersion)return json(res,423,{error:'Эта карточка создана до текущей проверки безопасности. Создайте новую сборку для просмотра и скачивания.',moderationCode:'MODERATION_REQUIRED'});
    try {const bytes=await readFile(asset.file_path);res.writeHead(200,{'Content-Type':asset.mime_type,'Cache-Control':'private, max-age=86400','X-Content-Type-Options':'nosniff','X-Catalog-Render-Mode':asset.render_mode});return res.end(bytes)} catch {return json(res,404,{error:'Файл изображения отсутствует.'})}
  }if(req.method==='GET' && url.pathname==='/api/admin/overview') {
    const u=requireAdmin(req,res); if(!u)return;
    return json(res,200,{
      users:db.prepare('SELECT COUNT(*) count FROM users WHERE role=?').get('user').count,
      activeUsers:db.prepare('SELECT COUNT(DISTINCT user_id) count FROM sessions WHERE expires_at>?').get(Date.now()).count,
      generations:db.prepare('SELECT COUNT(*) count FROM generations WHERE status=?').get('complete').count,
      tokensSold:db.prepare('SELECT COALESCE(SUM(delta),0) total FROM ledger WHERE kind IN (?,?)').get('test_topup','payment_topup').total,
      tokensUsed:db.prepare('SELECT COALESCE(SUM(-delta),0) total FROM ledger WHERE kind=?').get('generation_reserved').total,
      recentUsers:db.prepare('SELECT u.email,u.role,u.created_at,COALESCE(w.tokens,0) tokens FROM users u LEFT JOIN wallets w ON w.user_id=u.id ORDER BY u.created_at DESC LIMIT 20').all()
    });
  }
  if(req.method==='GET' && url.pathname==='/api/health') return json(res,200,{ok:true,demoPayments,adminTestTopup,aiConfigured:Boolean(apiKey&&model),registrationOpen,privateAccess,generationMode:'full-card',moderationEnabled:true,moderationConfigured:Boolean(apiKey&&moderationModel),moderationPolicyVersion});
  if(req.method!=='GET'&&req.method!=='HEAD') return json(res,405,{error:'Метод не поддерживается.'});
  const requested=url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname),allowedFiles=new Set(['/index.html','/app.js','/style.css','/studio-hero.png']);
  if(!allowedFiles.has(requested)) return json(res,404,{error:'Не найдено.'});
  const file=resolve(root,`.${requested}`);
  if(!file.startsWith(root+sep)) return json(res,404,{error:'Не найдено.'});
  try { const bytes=await readFile(file);res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'})[extname(file)],'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'});res.end(req.method==='HEAD'?undefined:bytes); }
  catch { json(res,404,{error:'Не найдено.'}); }
});
server.listen(port,host,()=>console.log(`Сервер слушает http://${host}:${port}`));
