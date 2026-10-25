import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import type { LocalRuntime } from '../runtime/localRuntime.js';
import { createResponseHelpers, serveStaticFile } from './httpUtils.js';
import { handleLocalRoute } from './localRoutes.js';
import { attachTerminalSockets } from './terminalSocket.js';

export function createServer(options:{localRuntime:LocalRuntime;distDir?:string;allowedOrigins?:string[];phoneOrigin?:()=>string|null}):http.Server {
  const origins=options.allowedOrigins??['http://127.0.0.1:5173','http://localhost:5173','http://127.0.0.1:4317','http://localhost:4317'];
  const allowed=new Set(origins),distDir=options.distDir??path.resolve(process.cwd(),'dist');
  const server=http.createServer(async(req,res)=>{
    const requestId=crypto.randomUUID(),{sendError}=createResponseHelpers(res,requestId),method=req.method??'GET';
    const host = req.headers.host ?? '';
    const localHost = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
    if (!localHost && host !== (options.phoneOrigin?.() ? new URL(options.phoneOrigin()!).host : '')) { sendError(403,'FORBIDDEN_ORIGIN','Phone access is disabled for this address'); return; }
    if (!localHost) {
      const revoke = () => { if (host !== (options.phoneOrigin?.() ? new URL(options.phoneOrigin()!).host : '')) res.destroy(); };
      server.on('phone-access-changed', revoke);
      res.once('close', () => server.off('phone-access-changed', revoke));
    }
    if(req.headers.origin){if(!allowed.has(req.headers.origin)&&req.headers.origin!==options.phoneOrigin?.()){sendError(403,'FORBIDDEN_ORIGIN','Origin is not allowed');return;}res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Methods','GET, HEAD, POST, DELETE, OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, Last-Event-ID');}
    if(method==='OPTIONS'){res.writeHead(204);res.end();return;}
    if(!['GET','HEAD','POST','DELETE'].includes(method)){sendError(405,'METHOD_NOT_ALLOWED',`Method ${method} is not allowed`);return;}
    try{const url=new URL(req.url??'/','http://127.0.0.1');if(url.pathname.startsWith('/api/'))await handleLocalRoute(options.localRuntime,req,res,requestId,url);else serveStaticFile(url.pathname,method,distDir,res,sendError);}catch{if(!res.headersSent)sendError(500,'INTERNAL','An unexpected server error occurred');else res.end();}
  });
  server.on('listening',()=>{const address=server.address();if(address&&typeof address!=='string')options.localRuntime.organization.setPort(address.port);});
  attachTerminalSockets(server,options.localRuntime,options.allowedOrigins,options.phoneOrigin);
  return server;
}
