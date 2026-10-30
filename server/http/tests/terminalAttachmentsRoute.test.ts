import test from 'node:test';import assert from 'node:assert/strict';
import {Readable} from 'node:stream';import type http from 'node:http';
import {handleLocalRoute} from '../localRoutes.js';import type {LocalRuntime} from '../../runtime/localRuntime.js';

test('terminal image route accepts only an explicit POST with bytes, never paths or submit flags',async()=>{
  const seen:unknown[][]=[];
  const runtime={store:{project:()=>({id:'p1'})},sessions:{pasteTerminalAttachments:async(...args:unknown[])=>{seen.push(args);return {ok:true};}}} as unknown as LocalRuntime;
  const run=async(method:string,body:unknown,query='')=>{
    const req=Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage;
    req.method=method;req.headers={'content-type':'application/json'};let status=0,result='';
    const res={writeHead:(code:number)=>{status=code;},end:(value:string)=>{result=value;}} as unknown as http.ServerResponse;
    await handleLocalRoute(runtime,req,res,'request',new URL('/api/projects/p1/nodes/n1/terminal-attachments'+query,'http://127.0.0.1'));
    return {status,result};
  };
  assert.equal((await run('GET',{})).status,405);
  for(const body of [{path:'C:/private.png'},{attachments:[],submit:true},{attachments:[],command:'anything'}])assert.equal((await run('POST',body)).status,400);
  assert.ok((await run('POST',{attachments:[]},'?runId=unrelated')).status>=400);
  assert.equal(seen.length,0);
  const attachments=[{name:'image.png',mimeType:'image/png',dataBase64:'iVBORw0KGgo='}];
  const accepted=await run('POST',{attachments});assert.equal(accepted.status,200,accepted.result);
  assert.deepEqual(seen,[['p1','n1',{attachments}]]);
});
