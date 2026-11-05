import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const moderationPolicy = readFileSync(new URL('./product-moderation-policy.txt', import.meta.url), 'utf8');
export const moderationPolicyVersion = 'product-v1-' + createHash('sha256').update(moderationPolicy).digest('hex').slice(0, 12);
export const moderationCategories = Object.freeze(['WAR_MILITARY','WEAPONS','SEXUAL','DRUGS','EXTREMISM_HATE','VIOLENCE_SELF_HARM','ILLEGAL_DANGEROUS','AGE_RESTRICTED','FRAUD_PRIVACY','OTHER_PROHIBITED','OFF_TOPIC','SCOPE_UNCLEAR','ROLE_OVERRIDE']);
const decisions = new Set(['ALLOW','REJECT','REVIEW']);
const codes = new Set(moderationCategories);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, expected) => plain(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const text = (value, limit) => typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const categories = value => Array.isArray(value) && value.length <= codes.size && new Set(value).size === value.length && value.every(code => codes.has(code));
function unavailable() { return Object.assign(new Error('Проверка безопасности временно недоступна. Попробуйте позже. Генерация остановлена.'), { status:503, moderationCode:'MODERATION_UNAVAILABLE' }); }

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
  return { decision:value.decision, categories:[...value.categories] };
}

export function moderationError(result) {
  let message = result.decision === 'REVIEW' ? 'Нужна дополнительная проверка. Загрузите более чёткое фото или уточните задачу.' : 'Этот товар или запрос не соответствует правилам сервиса. Карточка не создана.';
  if (result.categories.includes('OFF_TOPIC')) message = 'Сервис создаёт только карточки товаров. Загрузите фото и опишите нужное изображение.';
  if (result.categories.includes('SCOPE_UNCLEAR')) message = 'Уточните, какую карточку товара нужно создать или изменить.';
  if (result.categories.includes('ROLE_OVERRIDE')) message = 'Такой запрос нельзя обработать. Опишите задачу создания карточки товара.';
  return Object.assign(new Error(message), {status:422, moderationCode:'MODERATION_' + result.decision});
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
    audit?.({stage,policyVersion:moderationPolicyVersion,decision:'ERROR',categories:[],reason:'moderator_unavailable_or_invalid_response'});
    throw unavailable();
  }
  audit?.({stage,policyVersion:moderationPolicyVersion,decision:result.decision,categories:result.categories,reason:result.decision==='ALLOW'?'approved':result.decision==='REVIEW'?'additional_review_required':'policy_rejected'});
  if (result.decision !== 'ALLOW') throw moderationError(result);
  return result;
}
