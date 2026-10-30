import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { SourceStatus, SourceFile, SourceActionRequest, SourceActionResponse, SourceDiff } from '../../../shared/contracts.js';
import { CliError, GIT_PATH, GH_PATH } from '../../integrations/cli.js';
import type { AdeGit } from './git.js';
import type { WorkspaceFiles } from './workspaceFiles.js';

function invalid(message:string):never {throw new CliError('INVALID_ARGUMENT',message);}
const refName=(value:string)=>value.length<250&&!value.startsWith('-')&&!/[\s\x00-\x1f~^:?*\[\\]/.test(value)&&!value.includes('..');
export class SourceControl {
  private locks=new Set<string>();
  constructor(private git:AdeGit,private files:WorkspaceFiles){}
  private async root(projectId:string,worktreeId:string){const project=this.git.store.project(projectId);return this.git.requireWorktree(project,worktreeId);}
  private async run(root:string,args:string[],remote=false){
    const result=await this.git.runner(GIT_PATH,['--no-pager',...args],{cwd:root,timeoutMs:remote?90000:15000,maxStdout:4*1024*1024+1,maxStderr:8192,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never'}});
    if(Buffer.byteLength(result.stdout)>=4*1024*1024)throw new CliError('CLI_FAILED','Git output exceeded the collection limit. Inspect this checkout in Terminal.');
    if(result.exitCode!==0)throw new CliError('CLI_FAILED',result.stderr.replace(/https?:\/\/[^\s@]+@/g,'https://[redacted]@').slice(0,1500)||'Git operation failed. Inspect the repository before retrying.');return result.stdout;
  }
  private async optional(root:string,args:string[]){const result=await this.git.runner(GIT_PATH,args,{cwd:root,timeoutMs:15000,maxStdout:16384,maxStderr:2048});return result.exitCode===0?result.stdout.trim():null;}
  private async guard(projectId:string,worktreeId:string,root:string,file:string){
    if(!file||file.length>2000||file.includes('\\')||file.startsWith('/')||file.split('/').some(part=>!part||part==='.'||part==='..'||part.toLowerCase()==='.git')||/[\x00-\x1f\x7f]/.test(file))invalid('Invalid changed file path');
    await this.files.validateGitPath(root,file,projectId);
  }
  async status(projectId:string,worktreeId:string):Promise<SourceStatus>{
    const tree=await this.root(projectId,worktreeId),root=tree.path;
    const head=await this.git.headCommit(root),branch=await this.optional(root,['symbolic-ref','--quiet','--short','HEAD']);
    const raw=await this.run(root,['--no-optional-locks','status','--porcelain=v1','-z','--untracked-files=all','--no-renames']);
    const records=raw.split('\0').filter(Boolean),files:SourceFile[]=[];const stamps:unknown[]=[];let excluded=0;
    for(const record of records.slice(0,2000)){const file=record.slice(3);try{await this.guard(projectId,worktreeId,root,file);}catch{excluded++;continue;}const stat=await fs.lstat(path.join(root,file)).catch(()=>null);stamps.push([file,stat?.size,stat?.mtimeMs,stat?.ctimeMs]);files.push({path:file,index:record[0],worktree:record[1],added:null,removed:null});}
    const index=await this.run(root,['ls-files','--stage','-z']);
    const upstream=await this.optional(root,['rev-parse','--abbrev-ref','--symbolic-full-name','@{upstream}']);
    const counts=upstream&&head?await this.optional(root,['rev-list','--left-right','--count','HEAD...@{upstream}']):null;
    const [ahead,behind]=(counts??'0 0').split(/\s+/).map(Number);
    const refs=(await this.run(root,['for-each-ref','--format=%(refname:short)','refs/heads/','refs/remotes/origin/'])).trim().split('\n').filter(value=>refName(value)&&!value.endsWith('/HEAD')).slice(0,500);
    const originHead=await this.optional(root,['symbolic-ref','--quiet','--short','refs/remotes/origin/HEAD']);
    const base=[originHead,'origin/main','origin/master','main','master'].find(value=>value&&refs.includes(value))??null;
    const remoteHead=upstream?await this.optional(root,['rev-parse','--verify','@{upstream}']):null;
    const version=crypto.createHash('sha256').update(JSON.stringify([head,branch,raw,index,stamps,remoteHead,refs])).digest('hex');
    const conflicts=files.some(file=>file.index==='U'||file.worktree==='U'||['AA','DD'].includes(file.index+file.worktree));
    // Keep each layer separate so partially staged files show truthful totals.
    const byPath=new Map(files.map(file=>[file.path,file]));
    const statsResults=await Promise.allSettled([head?this.run(root,['diff','--numstat','-z','--no-renames','HEAD','--']):Promise.resolve(''),this.run(root,['diff','--cached','--numstat','-z','--no-renames','--']),this.run(root,['diff','--numstat','-z','--no-renames','--'])]);
    statsResults.forEach((result,layer)=>{if(result.status!=='fulfilled')return;for(const row of result.value.split('\0')){const match=/^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(row);if(!match)continue;const entry=byPath.get(match[3]);if(!entry)continue;const added=match[1]==='-'?null:Number(match[1]),removed=match[2]==='-'?null:Number(match[2]);if(layer===0){entry.added=added;entry.removed=removed;}else if(layer===1){entry.stagedAdded=added;entry.stagedRemoved=removed;}else{entry.workingAdded=added;entry.workingRemoved=removed;}}});
    // Untracked UTF-8 files have an empty baseline. Bound both each read and
    // the aggregate scan; unknown/binary counts remain absent.
    let budget=2*1024*1024;
    for(const entry of files.filter(file=>file.index==='?').slice(0,200)){
      if(budget<=0)break;let handle:Awaited<ReturnType<typeof fs.open>>|undefined;
      try{handle=await fs.open(path.join(root,entry.path),'r');const stat=await handle.stat();if(!stat.isFile()||stat.size>128*1024||stat.size>budget)continue;const bytes=Buffer.alloc(Math.min(128*1024+1,budget+1));let length=0;while(length<bytes.length){const result=await handle.read(bytes,length,bytes.length-length,length);if(!result.bytesRead)break;length+=result.bytesRead;}budget-=length;if(length>128*1024||length>stat.size)continue;const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length));if(text.includes('\0'))continue;const lines=(text.match(/\n/g)?.length??0)+(text.length&&!text.endsWith('\n')?1:0);entry.added=lines;entry.removed=0;entry.workingAdded=lines;entry.workingRemoved=0;}catch{/* Preserve unknown counts. */}finally{await handle?.close();}
    }
    return{worktreeId,branch,head,upstream,ahead:ahead||0,behind:behind||0,files,version,refs,base,canCreatePr:Boolean(branch&&base&&branch!==base.replace(/^origin\//,'')),conflicts,truncated:records.length>2000,excluded};
  }
  async diff(projectId:string,worktreeId:string,file:string,kind:'staged'|'working'|'branch',base?:string):Promise<SourceDiff>{
    const tree=await this.root(projectId,worktreeId);await this.guard(projectId,worktreeId,tree.path,file);
    if(kind!=='branch'){const changed=await this.run(tree.path,['--no-optional-locks','--literal-pathspecs','status','--porcelain=v1','-z','--untracked-files=all','--',file]);if(!changed)invalid('This file is no longer changed');}
    const show=async(spec:string)=>{const r=await this.git.runner(GIT_PATH,['show',spec],{cwd:tree.path,timeoutMs:15000,maxStdout:512*1024+1,maxStderr:2048});if(r.exitCode!==0){if(/does not exist|exists on disk, but not in|not in the index|not exist in/i.test(r.stderr))return '';throw new CliError('CLI_FAILED','Unable to read this Git blob. Refresh the repository and inspect it in Terminal.');}if(Buffer.byteLength(r.stdout)>=512*1024)throw new Error('Diff exceeds the display limit');return r.stdout;};
    try{
      let original='',modified='';
      if(kind==='branch'){const refs=(await this.run(tree.path,['for-each-ref','--format=%(refname:short)','refs/heads/','refs/remotes/origin/'])).trim().split('\n');const ref=base??(await this.status(projectId,worktreeId)).base;if(!ref||!refs.includes(ref)||!refName(ref))invalid('Choose a discovered base branch');const merge=(await this.run(tree.path,['merge-base','HEAD',ref])).trim();if(!/^[a-f0-9]{40,64}$/.test(merge))invalid('Unable to resolve comparison base');original=await show(`${merge}:${file}`);modified=await show(`HEAD:${file}`);}
      else if(kind==='staged'){const head=await this.git.headCommit(tree.path);original=head?await show(`${head}:${file}`):'';modified=await show(`:${file}`);}
      else {original=await show(`:${file}`);const stat=await fs.stat(path.join(tree.path,file)).catch(()=>null);if(stat){if(!stat.isFile()||stat.size>512*1024)return{path:file,original:'',modified:'',binary:true,reason:'This file is too large for an inline diff.'};modified=new TextDecoder('utf-8',{fatal:true}).decode(await fs.readFile(path.join(tree.path,file)));}}
      if(original.includes('\0')||modified.includes('\0')||original.includes('\ufffd')||modified.includes('\ufffd'))return{path:file,original:'',modified:'',binary:true,reason:'Binary content cannot be shown as a text diff.'};
      return{path:file,original,modified,binary:false};
    }catch(error){if(error instanceof CliError)throw error;return{path:file,original:'',modified:'',binary:true,reason:'This file cannot be displayed as a bounded UTF-8 diff.'};}
  }
  private base(status:SourceStatus,value?:string){const base=value??status.base;if(!base||!status.refs.includes(base)||!refName(base))invalid('Choose a discovered base branch');return base;}
  async reviewUrl(projectId:string,worktreeId:string,base?:string):Promise<string>{
    const tree=await this.root(projectId,worktreeId);
    const [branch,remote,originHead,refText]=await Promise.all([this.optional(tree.path,['symbolic-ref','--quiet','--short','HEAD']),this.optional(tree.path,['remote','get-url','origin']),this.optional(tree.path,['symbolic-ref','--quiet','--short','refs/remotes/origin/HEAD']),this.run(tree.path,['for-each-ref','--format=%(refname:short)','refs/heads/','refs/remotes/origin/'])]);
    if(!branch)invalid('Check out a branch before opening its GitHub comparison');
    const repository=/^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote??'')?.[1];
    if(!repository)invalid('This checkout does not have a supported GitHub origin remote');
    const refs=refText.trim().split('\n');
    if(base&&(!refs.includes(base)||!refName(base)))invalid('Choose a discovered base branch');
    const selected=(base??[originHead,'origin/main','origin/master','main','master'].find(ref=>ref&&refs.includes(ref))??branch).replace(/^origin\//,'');
    return `https://github.com/${repository}/compare/${encodeURIComponent(selected)}...${encodeURIComponent(branch)}?expand=1`;
  }
  async commitFiles(projectId:string,sha:string,nodeId?:string):Promise<import('../../../shared/contracts.js').CommitFiles>{
    if(!/^[a-f0-9]{40,64}$/.test(sha))invalid('Choose a discovered commit');
    const project=this.git.store.project(projectId),history=await this.git.history(project,nodeId),commit=history.data?.commits.find(commit=>commit.sha===sha);
    if(!commit)invalid('This commit is not in the loaded history scope');
    const tree=nodeId?await this.git.requireWorktree(project,nodeId):(await this.git.worktrees(project)).find(tree=>tree.main);
    if(!tree)invalid('The repository worktree is unavailable');
    const raw=await this.run(tree.path,commit.parents.length?['diff','--name-status','--no-renames','-z',commit.parents[0],sha,'--']:['diff-tree','--root','--no-commit-id','--name-status','--no-renames','-r','-z',sha,'--']);
    const parts=raw.split('\0').filter(Boolean),files:{path:string;status:string}[]=[];let excluded=0;
    for(let index=0;index+1<parts.length&&index<2000;index+=2){const file=parts[index+1];try{await this.guard(projectId,tree.id,tree.path,file);files.push({path:file,status:parts[index]});}catch{excluded++;}}
    return{sha,files,truncated:parts.length>2000,excluded};
  }
  async commitDiff(projectId:string,sha:string,file:string,nodeId?:string):Promise<SourceDiff>{
    const changed=await this.commitFiles(projectId,sha,nodeId),entry=changed.files.find(entry=>entry.path===file);
    if(!entry)invalid('Choose a changed file from this commit');
    const project=this.git.store.project(projectId),history=await this.git.history(project,nodeId),commit=history.data?.commits.find(commit=>commit.sha===sha);
    if(!commit)invalid('The commit is no longer in the loaded history scope');
    const tree=nodeId?await this.git.requireWorktree(project,nodeId):(await this.git.worktrees(project)).find(tree=>tree.main);
    if(!tree)invalid('The repository worktree is unavailable');
    const show=async(ref:string)=>{const result=await this.git.runner(GIT_PATH,['show',`${ref}:${file}`],{cwd:tree.path,timeoutMs:15000,maxStdout:512*1024+1,maxStderr:2048});if(result.exitCode!==0)throw new CliError('CLI_FAILED','Unable to read the committed file');if(Buffer.byteLength(result.stdout)>=512*1024||result.stdout.includes('\0')||result.stdout.includes('\ufffd'))throw new Error('Binary or oversized commit content');return result.stdout;};
    try{return{path:file,original:entry.status==='A'||!commit.parents.length?'':await show(commit.parents[0]),modified:entry.status==='D'?'':await show(sha),binary:false};}
    catch(error){if(error instanceof CliError)throw error;return{path:file,original:'',modified:'',binary:true,reason:'This committed file cannot be shown as a bounded UTF-8 diff.'};}
  }
  async compare(projectId:string,worktreeId:string,base?:string):Promise<SourceFile[]>{const tree=await this.root(projectId,worktreeId),status=await this.status(projectId,worktreeId),ref=this.base(status,base);const merge=(await this.run(tree.path,['merge-base','HEAD',ref])).trim();if(!/^[a-f0-9]{40,64}$/.test(merge))invalid('Unable to resolve comparison base');const raw=await this.run(tree.path,['diff','--name-status','-z','--no-renames',merge,'HEAD','--']);const parts=raw.split('\0'),files:SourceFile[]=[];for(let i=0;i+1<parts.length&&files.length<2000;i+=2){const file=parts[i+1];try{await this.guard(projectId,worktreeId,tree.path,file);files.push({path:file,index:parts[i],worktree:' ',added:null,removed:null});}catch{/* Private paths remain excluded. */}}return files;}
  async action(projectId:string,request:SourceActionRequest):Promise<SourceActionResponse>{
    const allowed=['stage','unstage','discard','commit','push','forcePush','pull','fetch','fastForward','sync','rebase','publish','createPr'];
    if(!allowed.includes(request.action)||typeof request.version!=='string')invalid('Choose a supported source-control action');
    const tree=await this.root(projectId,request.worktreeId),key=tree.path;
    if(this.locks.has(key))throw new CliError('RATE_LIMITED','A Git action is already running in this checkout');this.locks.add(key);
    try{
      const status=await this.status(projectId,request.worktreeId);if(status.truncated)invalid('Too many changed files. Narrow this checkout before modifying it.');if(status.version!==request.version)invalid('The repository changed. Refresh and review it before trying again.');
      const run=(args:string[],remote=false)=>this.run(tree.path,args,remote);
      if(request.action==='stage'||request.action==='unstage'||request.action==='discard'){
        const paths=request.paths??status.files.filter(file=>request.action!=='unstage'?file.worktree!==' '||file.index==='?':file.index!==' '&&file.index!=='?').map(file=>file.path);
        if(!Array.isArray(paths)||!paths.length||paths.length>2000||paths.some(file=>typeof file!=='string'||!status.files.some(entry=>entry.path===file)))invalid('Select current changed files');
        for(const file of paths)await this.guard(projectId,request.worktreeId,tree.path,file);
        if(request.action==='discard'){
          if(status.conflicts)invalid('Resolve conflicts in Terminal before discarding changes');
          const tracked:string[]=[],untracked:string[]=[];
          for(const file of paths){const entry=status.files.find(entry=>entry.path===file)!;if(entry.index==='?'){const stat=await fs.lstat(path.join(tree.path,file));if(!stat.isFile())invalid('Only regular untracked files can be discarded');untracked.push(file);}else{if(entry.worktree===' ')invalid('This file has no working-tree changes to discard');const index=await run(['--literal-pathspecs','ls-files','--stage','--',file]);if(!/^(100644|100755) /.test(index))invalid('This index entry cannot be restored here. Inspect it in Terminal.');tracked.push(file);}}
          if(tracked.length)await run(['--literal-pathspecs','restore','--worktree','--',...tracked]);
          for(const file of untracked){await this.guard(projectId,request.worktreeId,tree.path,file);await fs.unlink(path.join(tree.path,file));}
          return{ok:true};
        }
        await run(request.action==='stage'?['--literal-pathspecs','add','--',...paths]:status.head?['--literal-pathspecs','restore','--staged','--',...paths]:['--literal-pathspecs','rm','--cached','--ignore-unmatch','--',...paths]);
      } else if(request.action==='commit'){
        if(status.excluded)invalid('Some changed paths cannot be reviewed here. Inspect the index in Terminal before committing.');
        if(status.conflicts)invalid('Resolve merge conflicts before committing');if(!status.files.some(file=>file.index!==' '&&file.index!=='?'))invalid('Stage changes before committing');
        if(typeof request.message!=='string'||!request.message.trim()||request.message.length>10000||request.message.includes('\0'))invalid('Enter a commit message');
        await run(['commit','-m',request.message]);
      }else{
        if(request.action==='fetch'){await run(['fetch','--','origin'],true);return{ok:true};}
        if(!status.branch||!refName(status.branch))invalid('Check out a branch before performing this action');
        if(['pull','fastForward','sync','rebase'].includes(request.action)&&(status.files.length||status.excluded))invalid('Commit or stash local changes before integrating remote commits');
        if(status.conflicts)invalid('Resolve the repository conflicts first');
        if(['push','forcePush','pull','fastForward','sync'].includes(request.action)&&(!status.upstream||!status.upstream.startsWith('origin/')))invalid('Publish this branch to origin before using this action');
        const remoteBranch=status.upstream?.slice(7);if(remoteBranch&&!refName(remoteBranch))invalid('Invalid upstream branch');
        if(request.action==='publish')await run(['push','--set-upstream','--','origin',`HEAD:refs/heads/${status.branch}`],true);
        if(request.action==='push')await run(['push','--','origin',`HEAD:refs/heads/${remoteBranch}`],true);
        if(request.action==='forcePush'){const sha=await this.optional(tree.path,['rev-parse','--verify','@{upstream}']);if(!sha||!/^[a-f0-9]{40,64}$/.test(sha))invalid('Fetch the upstream branch first');await run(['push',`--force-with-lease=refs/heads/${remoteBranch}:${sha}`,'--','origin',`HEAD:refs/heads/${remoteBranch}`],true);}
        if(['pull','fastForward','sync'].includes(request.action)){await run(['fetch','--','origin'],true);await run(['merge','--ff-only','--',`refs/remotes/origin/${remoteBranch}`]);if(request.action==='sync')await run(['push','--','origin',`HEAD:refs/heads/${remoteBranch}`],true);}
        if(request.action==='rebase'){const base=this.base(status,request.base);await run(['rebase',base]);}
        if(request.action==='createPr'){
          const base=this.base(status,request.base).replace(/^origin\//,'');if(!status.canCreatePr||base===status.branch)invalid('Switch to a feature branch before creating a PR');
          if(status.upstream!==`origin/${status.branch}`||status.ahead||status.behind)invalid('Publish and synchronize this feature branch to the matching origin branch before creating a PR');
          const remote=await this.optional(tree.path,['remote','get-url','origin']);
          const repository=/^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote??'')?.[1];
          if(!repository)invalid('Create PR currently requires a GitHub origin remote');
          if(typeof request.title!=='string'||!request.title.trim()||request.title.length>250||typeof request.body!=='string'||request.body.length>30000||/[\x00]/.test(request.title+request.body))invalid('Enter a PR title and description');
          const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ade-pr-')),file=path.join(directory,'body.md');
          try{await fs.writeFile(file,request.body,{mode:0o600});const result=await this.git.runner(GH_PATH,['pr','create','--repo',repository,'--base',base,'--head',status.branch,'--title',request.title,'--body-file',file],{cwd:tree.path,timeoutMs:90000,maxStdout:8192,maxStderr:8192,env:{...process.env,GH_PROMPT_DISABLED:'1'}});if(result.exitCode!==0)throw new CliError('CLI_FAILED','PR creation was not confirmed. Inspect GitHub before retrying.');const url=result.stdout.trim().split('\n').find(value=>/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(value));if(!url)throw new CliError('CLI_FAILED','PR creation may have succeeded. Inspect GitHub before retrying.');return{ok:true,url};}finally{await fs.unlink(file).catch(()=>{});await fs.rmdir(directory).catch(()=>{});}
        }
      }
      return{ok:true};
    }finally{this.locks.delete(key);this.files.invalidate();}
  }
}
