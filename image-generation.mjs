const pageDetails = {
  main: ['Главная карточка', 'Название товара и основные подтверждённые характеристики.'],
  dimensions: ['Размеры', 'Покажи переданные габариты и понятные размерные выноски без выдуманных чисел.'],
  material: ['Материал', 'Подчеркни указанный материал, его внешний вид и только подтверждённые свойства.'],
  benefits: ['Преимущества', 'Выдели преимущества, которые прямо подтверждены описанием.'],
  composition: ['Состав', 'Покажи состав или комплектацию только по предоставленным сведениям.'],
  design: ['Дизайн', 'Сделай акцент на внешнем виде и деталях реального товара.'],
  convenience: ['Удобство', 'Покажи применение и удобство только по подтверждённому описанию.']
};
const styles = {
  minimal: 'Минимализм: чистая композиция, свободное пространство, аккуратная современная типографика.',
  natural: 'Натуральный стиль: тёплое освещение, естественные текстуры, спокойная композиция.',
  bold: 'Яркий стиль: выразительный контраст, крупные читаемые акценты и динамичная композиция.'
};
export function normalizeCustomPrompt(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 2000) throw Object.assign(new Error('Пожелания для нейросети должны быть текстом до 2000 символов.'), { status: 400 });
  return value.trim();
}
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
export function imageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return '';
}
export function validateCardRequest(body) {
  if (!body || typeof body !== 'object' || typeof body.page !== 'string' || !Object.hasOwn(pageDetails, body.page)) fail('Выберите страницу карточки.');
  const result = { page: body.page, customPrompt: normalizeCustomPrompt(body.customPrompt) };
  for (const [name, limit] of Object.entries({ name:120, sku:100, material:1000, dimensions:1000, description:3000 })) {
    const value = body[name] ?? '';
    if (typeof value !== 'string' || value.length > limit) fail('Проверьте текстовые характеристики товара.');
    result[name] = value.trim();
  }
  if (!result.name) fail('Укажите название товара.');
  const match = typeof body.photo === 'string' && body.photo.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) fail('Добавьте фото товара в PNG, JPG или WebP. Если страница давно открыта, обновите её.');
  if (match[2].length > Math.ceil(5000000 / 3) * 4) fail('Фото для нейросети должно быть не больше 5 МБ.', 413);
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 5000000) fail('Фото для нейросети должно быть не больше 5 МБ.', 413);
  if (bytes.toString('base64') !== match[2] || imageMime(bytes) !== match[1]) fail('Содержимое фотографии не соответствует формату PNG, JPG или WebP.');
  result.image = { bytes, mime: match[1] };
  result.style = Object.hasOwn(styles, body.style) ? body.style : 'minimal';
  result.color = /^#[0-9a-f]{6}$/i.test(body.color || '') ? body.color : '#087f5b';
  result.features = { dimensions: body.features?.dimensions !== false, material: body.features?.material !== false };
  return result;
}
export function buildCardPrompt(body) {
  const [page, purpose] = pageDetails[body.page];
  const facts = { название:body.name, артикул:body.sku, размеры:body.dimensions, материал:body.material, описание:body.description };
  return `Создай ПОЛНОСТЬЮ ГОТОВУЮ карточку-инфографику товара для маркетплейса на русском языке, используя приложенную фотографию как точный визуальный источник товара.
Страница: ${page}. ${purpose}
Подтверждённые сведения о товаре: ${JSON.stringify(facts)}.
Оформление: ${styles[body.style]} Акцентный цвет бренда: ${body.color}.
Общие акценты: размеры ${body.features.dimensions?'показывать при уместности':'на главной странице не добавлять'}, материал ${body.features.material?'показывать при уместности':'на главной странице не добавлять'}. Для специально выбранной страницы размеров или материала обязательно используй соответствующие переданные сведения.
${body.customPrompt ? `Личные пожелания клиента к всей карточке: ${body.customPrompt}\n` : ''}Самостоятельно создай всю финальную композицию: товар в окружении, фон, освещение, естественные тени, русские заголовки, подписи и уместные элементы инфографики. Никаких пустых зон для будущего наложения текста: после твоего ответа сайт ничего дорисовывать не будет.
Сохрани узнаваемый реальный товар: его форму, цвет, пропорции, количество элементов и конструктивные детали. Отдели товар от исходного фона и органично впиши его в композицию; не вставляй исходную фотографию прямоугольной наклейкой и не добавляй вокруг неё рамку. Не выдумывай свойства, преимущества, состав, размеры, сертификаты и логотипы. Не добавляй название сервиса или служебные надписи. Текст должен быть читаемым и без опечаток. Если сведений для утверждения нет, не делай такое утверждение.
Предпочтительна вертикальная композиция 3:4, если модель поддерживает такой формат. Товар целиком видим, без обрезанных деталей. Верни только законченное изображение карточки.`;
}
export async function generateProductCard(body, { base, apiKey, model }) {
  if (!apiKey) fail('На сервере не настроен AI_API_KEY.', 503);
  if (!model) fail('На сервере не настроен AI_IMAGE_MODEL.', 503);
  const form = new FormData();
  form.set('model', model);
  form.set('prompt', buildCardPrompt(body));
  form.set('n', '1');
  form.set('response_format', 'b64_json');
  const extension = body.image.mime === 'image/jpeg' ? 'jpg' : body.image.mime === 'image/webp' ? 'webp' : 'png';
  form.set('image', new Blob([body.image.bytes], { type: body.image.mime }), `product.${extension}`);
  const encoded = new Request(`${base}/images/edits`, { method: 'POST', body: form });
  const bytes = Buffer.from(await encoded.arrayBuffer());
  const upstream = await fetch(encoded.url, { method:'POST', headers:{ Authorization:`Bearer ${apiKey}`, 'Content-Type':encoded.headers.get('content-type'), 'Content-Length':String(bytes.length) }, body:bytes, signal:AbortSignal.timeout(610000), redirect:'error' });
  const payload = await upstream.json().catch(() => ({}));
  if (!upstream.ok) fail(payload?.error?.message || payload?.message || `Ошибка провайдера: HTTP ${upstream.status}`, [402,429].includes(upstream.status) ? upstream.status : 502);
  const image = payload?.data?.[0]?.b64_json;
  if (typeof image !== 'string' || image.length > 28000000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) fail('Нейросеть не вернула готовое изображение в ожидаемом формате.', 502);
  const decoded = Buffer.from(image, 'base64');
  const mime = imageMime(decoded);
  if (!mime || decoded.length > 20000000) fail('Нейросеть вернула неподдерживаемый или слишком большой файл.', 502);
  return `data:${mime};base64,${image}`;
}
