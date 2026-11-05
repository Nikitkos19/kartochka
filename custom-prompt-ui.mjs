import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
const appDir = dirname(fileURLToPath(import.meta.url));
let source = await readFile(join(appDir, 'app.js'), 'utf8');
const bootstrap = "window.addEventListener('hashchange',render);bootstrapAuth();";
assert.equal(source.split(bootstrap).length, 2);
source = source.replace(bootstrap, '');
let saved = '';
const elements = {
  '#custom-prompt': { value: '', focus() {} },
  '#custom-prompt-count': { textContent: '' },
  '#clear-custom-prompt': { disabled: true }
};
const sent = [];
const fixturePhoto='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';
let downloaded;
const context = vm.createContext({
  document: { querySelector: selector => elements[selector] || null, querySelectorAll: () => [] },
  localStorage: { getItem: () => null, setItem: (_key, value) => { saved = value; } },
  structuredClone, TextEncoder, console, FormData, Blob, AbortSignal, URL, fixturePhoto,
  captureDownload:(name,blob)=>{downloaded={name,blob}},
  setTimeout: callback => { callback(); return 1; }, clearTimeout() {},
  location: { hash: 'checkout' },
  fetch: async (_url, options) => { if(_url!=='/api/generate-image')return fetch(_url,options);sent.push(JSON.parse(options.body));return {ok:true,json:async()=>({tokens:8,generationId:'mock-id-'+sent.length,imageData:fixturePhoto,renderMode:'full-card'})}; }
});
vm.runInContext(source, context);
vm.runInContext("state.products=[{id:'one',sku:'ITEM-1',name:'Товар',dimensions:'10 см',material:'Пластик',description:'Описание',photo:fixturePhoto}];state.wallet.tokens=10;state.pages=['main','material'];state.customPrompt='</textarea><script>alert(1)</script>';", context);
const markup = vm.runInContext('checkout()', context);
assert.ok(markup.includes('Ваш промпт для нейросети'));
assert.ok(markup.includes('maxlength="2000"'));
assert.ok(markup.includes('&lt;/textarea&gt;&lt;script&gt;'));
assert.ok(!markup.includes('<script>alert(1)</script>'));
vm.runInContext('bind()', context);
const wishes = 'Светлая кухня, мягкий свет\nБежевые оттенки';
elements['#custom-prompt'].value = wishes;
elements['#custom-prompt'].oninput();
assert.equal(JSON.parse(saved).customPrompt, wishes);
assert.equal(elements['#custom-prompt-count'].textContent, `${wishes.length} / 2000 символов`);
assert.equal(elements['#clear-custom-prompt'].disabled, false);
vm.runInContext("render=()=>{};go=()=>{};save=()=>{};toast=()=>{};refreshWallet=async()=>{};cardImage=async()=>{throw Error('Template renderer must not run for a new AI card')};paymentAccepted=true;download=captureDownload;", context);
await vm.runInContext('generate()', context);
assert.equal(sent.length, 2);
assert.ok(sent.every(body => body.customPrompt === wishes));
assert.ok(sent.every(body => body.photo === fixturePhoto && body.sku === 'ITEM-1'));
assert.ok(sent.every(body => body.features.dimensions === true && body.features.material === true));
assert.equal(vm.runInContext('state.orders[0].customPrompt', context), wishes);
assert.equal(vm.runInContext('state.orders[0].renderMode',context),'full-card');
assert.equal(await vm.runInContext("pageImage(state.orders[0].products[0],'main',state.orders[0])",context),fixturePhoto);
await vm.runInContext('exportZip(state.orders[0])',context);
const archived=Buffer.from(await downloaded.blob.arrayBuffer());
assert.equal(archived.readUInt32LE(0),0x04034b50);
const imageOffset=30+archived.readUInt16LE(26)+archived.readUInt16LE(28);
const imageLength=archived.readUInt32LE(18);
assert.deepEqual(archived.subarray(imageOffset,imageOffset+imageLength),Buffer.from(fixturePhoto.split(',')[1],'base64'));
await vm.runInContext("currentProduct='one';tab='main';downloadCurrentImage()",context);
assert.deepEqual(Buffer.from(await downloaded.blob.arrayBuffer()),Buffer.from(fixturePhoto.split(',')[1],'base64'));
const historicRequests=[];
context.fetch=async(url,options)=>{
  if(url==='/api/generations/historic-asset/image'){
    historicRequests.push(url);
    return {ok:true,headers:new Headers({'X-Catalog-Render-Mode':'full-card'}),blob:async()=>new Blob([Buffer.from(fixturePhoto.split(',')[1],'base64')],{type:'image/png'})};
  }
  return fetch(url,options);
};
await vm.runInContext("pageImage(state.products[0],'main',{renderMode:'full-card',assets:{'one:main':'historic-asset'}})",context);
assert.deepEqual(historicRequests,['/api/generations/historic-asset/image']);
await assert.rejects(vm.runInContext("pageImage(state.products[0],'design',{assets:{},renderMode:'full-card'})",context));
elements['#clear-custom-prompt'].onclick();
assert.equal(vm.runInContext('state.customPrompt', context), '');
assert.equal(elements['#custom-prompt'].value, '');
assert.equal(elements['#clear-custom-prompt'].disabled, true);
console.log('PASS: prompt field/persistence, photo+settings sent on every selected page, full-card preview bypasses template renderer, PNG/ZIP preserve exact model bytes, missing pages never become templates.');
