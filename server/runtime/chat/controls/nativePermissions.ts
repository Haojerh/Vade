import type { AdeProvider, AgentChatOptions, SetAgentChatOptionRequest } from '../../../../shared/contracts.js';
import type { ChatControlIO } from './chatControlTypes.js';
import { CliError } from '../../../integrations/cli.js';

export class NativePermissionConfirmationRequired extends CliError {
  constructor(){super('RUNTIME_UNAVAILABLE','Confirm or cancel the full-access request in Terminal, then reopen Permissions. The change is not confirmed yet.');}
}

export function assertNoNativePermissionDialog(provider:string,screen:string):void {
  if(provider==='codex'&&/^\s*Enable full access\?\s*$/mi.test(screen)&&/^\s*(?:[›>❯]\s*)?\d+\.\s*(?:Yes, continue anyway|Cancel)\b/mi.test(screen))throw new NativePermissionConfirmationRequired();
}

export function nativeFullAccessConfirmation(screen:string):boolean {
  return /^\s*Enable full access\?\s*$/mi.test(screen)
    &&/^\s*(?:[›>❯]\s*)?1\.\s*Yes, continue anyway\b[^\n]*Apply full access for this session/mi.test(screen)
    &&/^\s*(?:[›>❯]\s*)?2\.\s*Cancel\b/mi.test(screen);
}

export const hasNativePermissions = (provider:string) => ['codex','claude','codebuddy','antigravity'].includes(provider);
const choices = {
  manual:{value:'manual',label:'Ask for approval',description:'Keep native approval prompts enabled.'},
  auto:{value:'auto',label:'Approve for me',description:'Let the provider review approval requests.'},
  yolo:{value:'yolo',label:'Full access',description:'Bypass native approval prompts.'},
  acceptEdits:{value:'acceptEdits',label:'Accept edits',description:'Approve file edits; keep other native checks.'},
  plan:{value:'plan',label:'Plan',description:'Use the provider’s planning mode.'},
  'read-only':{value:'read-only',label:'Read only',description:'Require approval for edits and internet access.'},
};

/** Native footer evidence only; a shortcuts footer alone never establishes policy. */
export function nativePermissionMode(provider:string,screen:string):string|undefined {
  const lines=screen.split('\n').filter(line=>line.trim()).slice(-12).reverse();
  for(const line of lines){
    if(provider==='antigravity'){
      const mode=line.match(/\b(default|manual|accept-edits|auto|plan|yolo)\s*·/i)?.[1]?.toLowerCase();
      if(mode)return ({default:'manual',manual:'manual','accept-edits':'acceptEdits',auto:'auto',plan:'plan',yolo:'yolo'} as Record<string,string>)[mode];
    } else if(provider==='claude'||provider==='codebuddy'){
      if(/⏸\s*plan (?:mode on|\+)/i.test(line))return 'plan';
      if(/⏵⏵\s*bypass permissions on/i.test(line))return 'yolo';
      if(/⏵⏵\s*accept edits on/i.test(line))return 'acceptEdits';
      if(/⏵⏵\s*auto mode on/i.test(line))return 'auto';
      // The native default-mode hint names the action of the next cycle.
      if(/shift\+tab to (?:auto-accept|accept) edits/i.test(line))return 'manual';
    }
  }
  return undefined;
}

export function withNativePermissions(options:AgentChatOptions,screen:string,live:boolean):AgentChatOptions {
  if(!hasNativePermissions(options.provider)||!live)return options;
  const modes=options.provider==='codex'?['manual','auto','yolo','read-only']:options.provider==='antigravity'?['manual','acceptEdits','auto','plan']:['manual','acceptEdits','plan','auto','yolo'];
  const current=nativePermissionMode(options.provider,screen)??options.current.permission;
  return {...options,permissions:modes.map(mode=>mode==='auto'&&options.provider==='antigravity'?{value:'auto',label:'Auto',description:'Auto-approve edits and safe commands.'}:choices[mode as keyof typeof choices]),permissionsRequireRestart:false,
    ...(nativePermissionMode(options.provider,screen)?{permissionCurrentSource:'native' as const}:{}),current:{...options.current,...(current?{permission:current}:{})}};
}

function permissionMenu(screen:string){
  if(!/permissions|approval|access/i.test(screen))return [];
  return screen.split('\n').flatMap(line=>{
    const match=line.match(/^\s*([›>❯])?\s*(\d+)\.\s+(.+?)\s*$/);
    if(!match)return [];
    const label=match[3].trim().toLowerCase();
    const mode=/^ask for approval\b/.test(label)?'manual':/^approve for me\b/.test(label)?'auto':/^full access\b/.test(label)?'yolo':/^read only\b/.test(label)?'read-only':undefined;
    return mode?[{mode,selected:Boolean(match[1]),current:/\(current\)/i.test(label),index:Number(match[2])}]:[];
  });
}

export async function applyNativePermission(options:AgentChatOptions,request:SetAgentChatOptionRequest,io:ChatControlIO):Promise<AgentChatOptions>{
  if(request.key!=='permission'||!options.permissions?.some(row=>row.value===request.value)||!hasNativePermissions(options.provider))throw new CliError('INVALID_ARGUMENT','Choose an advertised native permission mode.');
  const requestedFullAccess=options.provider==='codex'&&request.value==='yolo';
  const existingFullAccess=requestedFullAccess&&nativeFullAccessConfirmation(io.screen());
  if(!existingFullAccess)assertNoNativePermissionDialog(options.provider,io.screen());
  const success=(mode:string):AgentChatOptions=>({...options,current:{...options.current,permission:mode},permissionCurrentSource:'native',permissionsRequireRestart:false});
  if(options.provider==='codex'){
    const confirmFullAccess=async()=>{
      const screen=io.screen();
      if(!nativeFullAccessConfirmation(screen))throw new CliError('RUNTIME_UNAVAILABLE','The native permission confirmation changed. Inspect Terminal.');
      if(/^\s*[›>❯]\s*2\.\s*Cancel\b/mi.test(screen)){
        const before=io.outputCursor?.()??io.output().length;
        await io.write('\x1b[A');
        await io.waitFor(value=>(io.outputCursor?.()??io.output().length)>before&&nativeFullAccessConfirmation(value)&&/^\s*[›>❯]\s*1\.\s*Yes, continue anyway\b/mi.test(value));
      }
      if(!nativeFullAccessConfirmation(io.screen())||!/^\s*[›>❯]\s*1\.\s*Yes, continue anyway\b/mi.test(io.screen()))throw new CliError('RUNTIME_UNAVAILABLE','Select the native full-access confirmation in Terminal.');
      // The user explicitly chose Full access. Confirm only this fixed warning,
      // once, under the same owned-session lock; never approve a tool or setup.
      await io.write('\r');
      await io.waitFor(value=>!nativeFullAccessConfirmation(value)&&!permissionMenu(value).length&&(io.promptEmpty?.()??/^\s*[›>]\s*$/m.test(value)));
    };
    if(existingFullAccess)await confirmFullAccess();
    else {
    // Fixed native command, typed rather than pasted. Never submit user prose.
    for(const char of '/permissions'){await io.write(char);await new Promise(resolve=>setTimeout(resolve,20));}
    await io.write('\r');
    const screen=await io.waitFor(value=>permissionMenu(value).some(row=>row.selected));
    const rows=permissionMenu(screen),selected=rows.find(row=>row.selected),target=rows.find(row=>row.mode===request.value);
    if(!selected||!target)throw new CliError('RUNTIME_UNAVAILABLE','This native permission picker does not offer that mode. Choose it in Terminal.');
    const delta=rows.indexOf(target)-rows.indexOf(selected),direction=Math.sign(delta);
    for(let n=1;n<=Math.abs(delta);n++){
      const expected=rows[rows.indexOf(selected)+direction*n].mode;
      const before=io.outputCursor?.()??io.output().length;
      await io.write(direction>0?'\x1b[B':'\x1b[A');
      await io.waitFor(value=>{
        assertNoNativePermissionDialog(options.provider,value);
        return (io.outputCursor?.()??io.output().length)>before&&permissionMenu(value).some(row=>row.selected&&row.mode===expected);
      });
    }
    // Revalidate the current rendered row immediately before the only Enter.
    if(!permissionMenu(io.screen()).some(row=>row.selected&&row.mode===request.value))throw new CliError('RUNTIME_UNAVAILABLE','The native permission picker changed. Choose the mode in Terminal.');
    await io.write('\r');
    // Do not approve a secondary native warning. Only reopen after the empty
    // prompt returns, then read the native '(current)' marker as confirmation.
    const afterSelection=await io.waitFor(value=>{
      if(nativeFullAccessConfirmation(value)){
        if(!requestedFullAccess)throw new NativePermissionConfirmationRequired();
        return true;
      }
      assertNoNativePermissionDialog(options.provider,value);
      return !permissionMenu(value).length&&(io.promptEmpty?.()??/^\s*[›>]\s*$/m.test(value));
    });
    if(nativeFullAccessConfirmation(afterSelection))await confirmFullAccess();
    }
    for(const char of '/permissions'){await io.write(char);await new Promise(resolve=>setTimeout(resolve,20));}
    await io.write('\r');
    await io.waitFor(value=>permissionMenu(value).some(row=>row.current&&row.mode===request.value));
    await io.write('\x1b');
    await io.waitFor(value=>!permissionMenu(value).length&&(io.promptEmpty?.()??/^\s*[›>]\s*$/m.test(value)));
    return success(request.value);
  }
  let previous=nativePermissionMode(options.provider,io.screen());
  if(previous===request.value)return success(previous);
  const visited=new Set<string>();
  if(previous)visited.add(previous);
  for(let step=0;step<6;step++){
    const before=io.outputCursor?.()??io.output().length;
    await io.write('\x1b[Z'); // Native Shift+Tab; never a prompt or approval answer.
    let next:string|undefined,stable='',stableAt=0;
    await io.waitFor(screen=>{
      const fresh=(io.outputCursor?.()??io.output().length)>before;
      next=nativePermissionMode(options.provider,screen);
      // Default has no mode badge in these native TUIs. Only a fresh, stable
      // empty-prompt redraw after a witnessed mode can confirm its disappearance.
      if(!next&&previous&&/\? for shortcuts/.test(screen)&&(io.promptEmpty?.()??/^\s*[›>]\s*$/m.test(screen))){
        if(screen!==stable){stable=screen;stableAt=Date.now();}
        else if(Date.now()-stableAt>=120)next='manual';
      }
      return fresh&&Boolean(next)&&next!==previous;
    });
    if(next===request.value)return success(next);
    if(!next||visited.has(next))break;
    visited.add(next);previous=next;
  }
  throw new CliError('RUNTIME_UNAVAILABLE','The native cycle did not expose that mode. Inspect Terminal; no input was replayed.');
}
