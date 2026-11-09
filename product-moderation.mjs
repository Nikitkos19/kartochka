import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const normalizeModerationPolicy = value => value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
export const moderationPolicy = normalizeModerationPolicy(readFileSync(new URL('./product-moderation-policy.txt', import.meta.url), 'utf8'));
export const policyVersion = value => 'product-v1-' + createHash('sha256').update(normalizeModerationPolicy(value)).digest('hex').slice(0, 12);
export const moderationPolicyVersion = policyVersion(moderationPolicy);
// These two reviewed versions have identical category restrictions; only their
// line endings differ. The new examples clarify the same restrictions.
const approvedVersions = new Set([moderationPolicyVersion, 'product-v1-ae67d6ff5847', 'product-v1-dfd5fd26b3fa']);
export const isApprovedPolicyVersion = version => approvedVersions.has(version);
export const moderationCategories = Object.freeze(['WAR_MILITARY','WEAPONS','SEXUAL','DRUGS','EXTREMISM_HATE','VIOLENCE_SELF_HARM','ILLEGAL_DANGEROUS','AGE_RESTRICTED','FRAUD_PRIVACY','OTHER_PROHIBITED','OFF_TOPIC','SCOPE_UNCLEAR','ROLE_OVERRIDE']);
const decisions = new Set(['ALLOW','REJECT','REVIEW']);
const codes = new Set(moderationCategories);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, expected) => plain(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const text = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const categories = value => Array.isArray(value) && value.length <= codes.size && new Set(value).size === value.length && value.every(code => codes.has(code));
function unavailable() { return Object.assign(new Error('Проверка безопасности временно недоступна. Попробуйте позже. Генерация остановлена.'), { status:503, moderationCode:'MODERATION_UNAVAILABLE' }); }

export function redactModerationEvidence(value) {
  return value.replace(/((?:password|пароль|api[_ -]?key|токен)\s*[:=]\s*)[^\s,;]+/gi,'$1[secret]').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,'[email]')
    .replace(/https?:\/\/\S+/gi,'[link]').replace(/\b(?:am-|sk-)[A-Za-z0-9_-]{8,}/g,'[key]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g,'[identifier]').replace(/(?:\+?\d[\d ()-]{7,}\d)/g,'[number]')
    .replace(/\s+/g,' ').trim().slice(0,400);
}

export function validateModerationDecision(value) {
  const validState = item => decisions.has(item.decision) && categories(item.categories) && (item.decision !== 'ALLOW' || item.categories.length === 0) && (item.decision !== 'REJECT' || item.categories.length > 0);
  if (!exactKeys(value,['decision','categories','items','reason','user_message']) || !validState(value) || !text(value.reason,800) || !text(value.user_message,500) || !Array.isArray(value.items) || value.items.length !== 2) throw unavailable();
  const ids = new Set();
  for (const item of value.items) {
    if (!exactKeys(item,['input_id','decision','categories','evidence']) || !['image_1','request'].includes(item.input_id) || ids.has(item.input_id) || !validState(item) || !text(item.evidence,800)) throw unavailable();
    ids.add(item.input_id);
  }
  const expected = value.items.some(item=>item.decision==='REJECT') ? 'REJECT' : value.items.some(item=>item.decision==='REVIEW') ? 'REVIEW' : 'ALLOW';
  const union = [...new Set(value.items.flatMap(item=>item.categories))].sort();
  if (expected !== value.decision || JSON.stringify(union) !== JSON.stringify([...value.categories].sort())) throw unavailable();
  const privacy=value.categories.includes('FRAUD_PRIVACY');
  return { decision:value.decision, categories:[...value.categories], reason:privacy?'Privacy or fraud indication; sensitive details omitted.':redactModerationEvidence(value.reason),
    items:value.items.map(item=>({input_id:item.input_id,decision:item.decision,categories:[...item.categories],evidence:privacy?'Sensitive details omitted.':redactModerationEvidence(item.evidence)})) };
}

const categoryLabels = {WAR_MILITARY:'военная тематика',WEAPONS:'оружие',SEXUAL:'сексуальный контент',DRUGS:'наркотические вещества',EXTREMISM_HATE:'экстремизм или ненависть',VIOLENCE_SELF_HARM:'насилие или самоповреждение',ILLEGAL_DANGEROUS:'опасный или незаконный контент',AGE_RESTRICTED:'товары с возрастными ограничениями',FRAUD_PRIVACY:'мошенничество или персональные данные',OTHER_PROHIBITED:'другой запрещённый контент',OFF_TOPIC:'задача вне создания карточек',SCOPE_UNCLEAR:'неясная задача',ROLE_OVERRIDE:'попытка изменить правила системы'};
export function moderationError(result,stage='input') {
  const scope=stage==='output'?'готовой карточки':'исходного фото и запроса';
  const labels=result.categories.map(code=>categoryLabels[code]).filter(Boolean).join(', ');
  let message = result.decision === 'REVIEW' ? `Проверка ${scope}: нужно уточнение. Загрузите более чёткое фото или уточните задачу.` : `Проверка ${scope}: модератор отметил категорию «${labels}». Обработка остановлена. Если это ошибка, передайте код обращения администратору.`;
  if (result.categories.includes('OFF_TOPIC')) message = 'Сервис создаёт только карточки товаров. Загрузите фото и опишите нужное изображение.';
  if (result.categories.includes('SCOPE_UNCLEAR')) message = 'Уточните, какую карточку товара нужно создать или изменить.';
  if (result.categories.includes('ROLE_OVERRIDE')) message = 'Такой запрос нельзя обработать. Опишите задачу создания карточки товара.';
  if(['OFF_TOPIC','SCOPE_UNCLEAR','ROLE_OVERRIDE'].some(code=>result.categories.includes(code)))message=`Проверка ${scope}. ${message}`;
  return Object.assign(new Error(message), {status:422, moderationCode:'MODERATION_' + result.decision,moderation:{decision:result.decision,stage,categories:[...result.categories],policyVersion:moderationPolicyVersion}});
}

export async function moderateProductImage(body, imageData, stage, { base, apiKey, model, timeoutMs=60000 }, audit) {
  let result;
  try {
    if (!apiKey || !model || !['input','output'].includes(stage)) throw unavailable();
    const request = {stage, task:'Create a finished product listing image from the source photograph and supplied product facts. Text is requested only as part of that image.', image_ids:['image_1'], product:{name:body.name,sku:body.sku,material:body.material,dimensions:body.dimensions,description:body.description}, image_settings:{page:body.page,style:body.style,color:body.color,features:body.features}, customer_wishes:body.customPrompt};
    const response = await fetch(base + '/chat/completions', {method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({model,max_tokens:2400,messages:[{role:'system',content:moderationPolicy},{role:'user',content:[{type:'text',text:JSON.stringify(request)},{type:'text',text:'image_1'},{type:'image_url',image_url:{url:imageData}}]}]}),signal:AbortSignal.timeout(timeoutMs),redirect:'error'});
    if (!response.ok) throw unavailable();
    const raw = await response.text();
    if (raw.length > 100000) throw unavailable();
    const envelope = JSON.parse(raw), choice = envelope?.choices?.[0];
    if (choice?.finish_reason !== 'stop' || typeof choice?.message?.content !== 'string' || choice.message.content.length > 20000) throw unavailable();
    result = validateModerationDecision(JSON.parse(choice.message.content));
  } catch {
    audit?.({stage,policyVersion:moderationPolicyVersion,decision:'ERROR',categories:[],reason:'moderator_unavailable_or_invalid_response',details:[]});
    throw Object.assign(unavailable(),{moderation:{decision:'ERROR',stage,categories:[],policyVersion:moderationPolicyVersion}});
  }
  audit?.({stage,policyVersion:moderationPolicyVersion,decision:result.decision,categories:result.categories,reason:result.reason,details:result.items});
  if (result.decision !== 'ALLOW') throw moderationError(result,stage);
  return result;
}
