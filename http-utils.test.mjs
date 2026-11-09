import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {readBody,parseCookies} from './http-utils.mjs';

test('Russian text and emoji survive every UTF-8 buffer boundary',async()=>{
 const value={name:'Стул',description:'Мягкое кресло 🌲',customPrompt:'Тёплый свет'};
 const bytes=Buffer.from(JSON.stringify(value));
 for(let index=1;index<bytes.length;index++)assert.deepEqual(await readBody(Readable.from([bytes.subarray(0,index),bytes.subarray(index)])),value);
 assert.deepEqual(await readBody(Readable.from([...bytes].map(b=>Buffer.from([b])))),value);
});
test('Body limit counts bytes and rejects invalid or incomplete input',async()=>{
 const bytes=Buffer.from('{"name":"стул"}');
 await assert.rejects(()=>readBody(Readable.from([bytes]),bytes.length-1),e=>e.status===413);
 assert.deepEqual(await readBody(Readable.from([bytes]),bytes.length),{name:'стул'});
 await assert.rejects(()=>readBody(Readable.from([Buffer.from([0xff])])),e=>e.status===400);
 await assert.rejects(()=>readBody(Readable.from([Buffer.from('{')])),e=>e.status===400);
 const request=new EventEmitter(),pending=readBody(request);request.emit('aborted');await assert.rejects(pending,e=>e.status===400);
});
test('Invalid cookies are ignored without throwing or losing valid neighbours',()=>{
 assert.equal(parseCookies('invalid=%; catalog_session=valid%3Dvalue').catalog_session,'valid=value');
 assert.equal(parseCookies('catalog_session=%').catalog_session,undefined);
 assert.equal(parseCookies('no_equals').no_equals,undefined);
 assert.equal(Object.getPrototypeOf(parseCookies('__proto__=fixture')),null);
 assert.doesNotThrow(()=>parseCookies(null));
});
