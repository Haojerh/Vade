import { spawn } from 'node:child_process';
import type { WorkflowModel } from '../../shared/contracts.js';
import { resolveAgent } from './sessions.js';
import { CliError } from '../integrations/cli.js';

/** The shipped CLI's metadata-only namespace. Never submits a task. */
export function dshCatalog(): Promise<WorkflowModel[]> {
  const resolved = resolveAgent('dsh');
  if (!resolved) throw new CliError('CLI_MISSING', 'Install dsh and dsh-tui to discover DeepSeek Harness models');
  return new Promise((resolve,reject)=>{
    const child=spawn(resolved.executable,[...resolved.args,'cli','models','list','--output-format','json'],{windowsHide:true,stdio:['ignore','pipe','ignore']});
    let output='',done=false;
    const failure=()=>new CliError('RUNTIME_UNAVAILABLE','The native DSH model catalog is unavailable. Check its profile setup in Terminal and retry.');
    const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);child.kill();if(error){reject(error);return;}
      try {
        const row=output.split('\n').map(line=>{try{return JSON.parse(line)}catch{return null}}).find(row=>row?.schemaVersion===1&&row.type==='result'&&row.ok===true);
        const safe=(s:unknown):s is string=>typeof s==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]{0,199}$/.test(s);
        const models:WorkflowModel[]=(Array.isArray(row?.data)?row.data:[]).slice(0,20).flatMap((provider:any)=>safe(provider.provider)&&Array.isArray(provider.models)?provider.models.slice(0,100).filter((m:any)=>safe(m.id)&&typeof m.name==='string').map((m:any)=>({id:provider.provider+'/'+m.id,label:m.name.slice(0,160),efforts:[]})):[]).filter((m:WorkflowModel)=>safe(m.id)).slice(0,200);
        models.length?resolve(models):reject(failure());
      }catch{reject(failure())}
    };
    const timer=setTimeout(()=>finish(failure()),20000);
    child.stdout.on('data',chunk=>{output+=chunk.toString();if(Buffer.byteLength(output)>262144)finish(failure())});
    child.once('error',()=>finish(failure()));child.once('close',code=>finish(code===0?undefined:failure()));
  });
}
