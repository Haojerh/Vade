import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import type { LocalRuntime } from '../runtime/localRuntime.js';
import { createResponseHelpers, serveStaticFile } from './httpUtils.js';
import { handleLocalRoute } from './localRoutes.js';
import { attachTerminalSockets } from './terminalSocket.js';

export function createServer(options:{localRuntime:LocalRuntime;distDir?:string;allowedOrigins?:string[]}):http.Server {
  const origins=options.allowedOrigins??['http://127.0.0.1:5173','http://localhost:5173','http://127.0.0.1:4317','http://localhost:4317'];
  const allowed=new Set(origins),distDir=options.distDir??path.resolve(process.cwd(),'dist');
  const server=http.createServer(async(req,res)=>{
    const requestId=crypto.randomUUID(),{sendError}=createResponseHelpers(res,requestId),method=req.method??'GET';
    if(req.headers.origin){if(!allowed.has(req.headers.origin)){sendError(403,'FORBIDDEN_ORIGIN','Origin is not allowed');return;}res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Access-Control-Allow-Methods','GET, HEAD, POST, DELETE, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, Last-Event-ID');}
    if(method==='OPTIONS'){res.writeHead(204);res.end();return;}
    if(!['GET','HEAD','POST','DELETE'].includes(method)){sendError(405,'METHOD_NOT_ALLOWED',`Method ${method} is not allowed`);return;}
    try{const url=new URL(req.url??'/','http://127.0.0.1');if(url.pathname.startsWith('/api/'))await handleLocalRoute(options.localRuntime,req,res,requestId,url);else serveStaticFile(url.pathname,method,distDir,res,sendError);}catch{if(!res.headersSent)sendError(500,'INTERNAL','An unexpected server error occurred');else res.end();}
  });
  server.on('listening',()=>{const address=server.address();if(address&&typeof address!=='string')options.localRuntime.organization.setPort(address.port);});
  attachTerminalSockets(server,options.localRuntime,options.allowedOrigins);
  return server;
}
