import test from 'node:test';import assert from 'node:assert/strict';
import {readTerminalClipboard} from '../features/workflow/terminal/terminalClipboard';

test('clipboard images take precedence over incidental text and use one native format per item',async()=>{
  const requested:string[]=[];
  const result=await readTerminalClipboard({read:async()=>[{types:['text/plain','image/jpeg','image/png'],getType:async(type:string)=>{requested.push(type);return new Blob(['image bytes'],{type});}}],readText:async()=>{throw Error('text-only clipboard access must not discard images');}} as any);
  assert.deepEqual(requested,['image/png']);assert.equal(result.files.length,1);assert.equal(result.files[0].type,'image/png');assert.equal(result.text,'');
});
test('text clipboard pasting and readText-only browser fallback are preserved',async()=>{
  const text=await readTerminalClipboard({read:async()=>[{types:['text/plain'],getType:async()=>new Blob(['hello'])}],readText:async()=>''} as any);
  assert.deepEqual(text,{files:[],text:'hello'});
  assert.deepEqual(await readTerminalClipboard({readText:async()=>'fallback'} as any),{files:[],text:'fallback'});
});
test('denied clipboard reads remain failures rather than empty successful pastes',async()=>{
  await assert.rejects(readTerminalClipboard({read:async()=>{throw Error('denied');}} as any),/denied/);
});
