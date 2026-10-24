import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { WorkspaceFileActionRequest, WorkspaceFileActionResult, WorkspaceFileStat } from '../../shared/contracts.js';
import type { AdeStore } from './store.js';
import type { WorkspaceFiles } from './workspaceFiles.js';
import { CliError } from '../integrations/cli.js';

function invalid(message: string): never { throw new CliError('INVALID_ARGUMENT', message); }
const exists = async (file: string) => { try { await fs.lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } };
export class WorkspaceActions {
  private locks = new Set<string>();
  constructor(private store: AdeStore, private files: WorkspaceFiles) {}
  private async moveExclusive(source: string, destination: string, directory: boolean) {
    if (await exists(destination)) invalid('The destination already exists');
    if (directory) { await fs.rename(source,destination); return; }
    // Creating the destination link is exclusive, even if another writer races us.
    await fs.link(source,destination);
    const [current,linked]=await Promise.all([fs.lstat(source),fs.lstat(destination)]);
    if(current.ino!==linked.ino || current.dev!==linked.dev) invalid('The source changed during the move. Inspect both paths before trying again.');
    await fs.unlink(source);
  }
  private async trashRoot() {
    const root=path.join(await fs.realpath(this.store.directory),'file-trash');
    await fs.mkdir(root,{recursive:true,mode:0o700});
    if((await fs.lstat(root)).isSymbolicLink()) invalid('Vade Trash is unavailable');
    return root;
  }
  private async scan(target: string, guard?: (file: string) => Promise<unknown>) {
    const entries: { relative: string; directory: boolean; mode: number }[] = [], pending = [''];
    const digest = crypto.createHash('sha256'), started = Date.now(); let bytes = 0;
    while (pending.length) {
      if(Date.now()-started>5000) invalid('Select a smaller item; the file operation exceeded its scan limit');
      const relative = pending.shift()!, file = path.join(target, relative); await guard?.(file); const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory() || relative.split(path.sep).some(part => part.toLowerCase() === '.git')) invalid('Operations on symbolic links, Git metadata or special files are not supported');
      if (entries.length >= 2000) invalid('Select a smaller folder (at most 2,000 entries)');
      entries.push({ relative, directory: stat.isDirectory(), mode: stat.mode });
      digest.update(JSON.stringify([relative,stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs]));
      if (stat.isDirectory()) {
        const directory = await fs.opendir(file);
        for await (const entry of directory) { if (pending.length + entries.length >= 2000) invalid('Select a smaller folder (at most 2,000 entries)'); pending.push(path.join(relative, entry.name)); }
      } else {
        if (stat.size > 32 * 1024 * 1024 || (bytes += stat.size) > 32 * 1024 * 1024) invalid('Select at most 32 MiB for file operations');
        const handle = await fs.open(file, 'r');
        try { const buffer = Buffer.alloc(65536); let read = 0; for (;;) { const part = await handle.read(buffer,0,buffer.length,null); if (!part.bytesRead) break; read += part.bytesRead; if (read > stat.size) invalid('The file changed. Reopen its menu before trying again.'); digest.update(buffer.subarray(0,part.bytesRead)); } } finally { await handle.close(); }
      }
    }
    return { entries, version: digest.digest('hex') };
  }
  async stat(projectId: string, worktreeId: string, relative: string): Promise<WorkspaceFileStat> {
    if (!relative) invalid('Select a file or folder');
    const scope = await this.files.ownedPath(projectId, worktreeId, relative);
    const scan = await this.scan(scope.target, file => this.files.ownedPath(projectId,worktreeId,path.relative(scope.root,file).replaceAll('\\','/'))); return { version: scan.version, directory: scan.entries[0].directory };
  }
  async change(projectId: string, request: WorkspaceFileActionRequest): Promise<WorkspaceFileActionResult> {
    if (!request || !['file','folder','duplicate','copy','rename','trash','restore'].includes(request.action)) invalid('Select a supported file action');
    const key = `${projectId}:${request.worktreeId}`;
    if (this.locks.has(key)) invalid('A file operation is already in progress in this worktree');
    this.locks.add(key);
    try {
      if (request.action === 'restore') {
        if (!/^[0-9a-f-]{36}$/.test(request.restoreId ?? '')) invalid('Invalid restore reference');
        const directory = path.join(await this.trashRoot(),request.restoreId!), manifest = path.join(directory,'entry.json');
        if((await fs.lstat(directory)).isSymbolicLink() || (await fs.lstat(manifest)).isSymbolicLink()) invalid('Invalid Trash record');
        const handle = await fs.open(manifest,'r'); let metadata: {projectId:string;worktreeId:string;relative:string};
        try { const buffer = Buffer.alloc(8193), result = await handle.read(buffer,0,buffer.length,0); if(result.bytesRead>8192) invalid('Invalid Trash record'); metadata=JSON.parse(buffer.subarray(0,result.bytesRead).toString()); } finally { await handle.close(); }
        if (metadata.projectId !== projectId || metadata.worktreeId !== request.worktreeId) invalid('Trash entry does not belong to this worktree');
        const target = await this.files.ownedPath(projectId,request.worktreeId,metadata.relative,true);
        if (await exists(target.target)) invalid('A file already exists at the original path. Rename it before restoring.');
        const scan=await this.scan(path.join(directory,'data'));
        await this.moveExclusive(path.join(directory,'data'),target.target,scan.entries[0].directory);
        await fs.unlink(manifest).catch(()=>{}); await fs.rmdir(directory).catch(()=>{});
        return { path: metadata.relative };
      }
      if (request.action === 'file' || request.action === 'folder') {
        const target = await this.files.ownedPath(projectId,request.worktreeId,request.path,true);
        if (request.action === 'file') await fs.writeFile(target.target,'',{flag:'wx'}); else await fs.mkdir(target.target);
        return { path: request.path };
      }
      if (!request.path || !/^[a-f0-9]{64}$/.test(request.version ?? '')) invalid('Reopen the file menu before modifying this item');
      const source = await this.files.ownedPath(projectId,request.worktreeId,request.path), scan = await this.scan(source.target, file => this.files.ownedPath(projectId,request.worktreeId,path.relative(source.root,file).replaceAll('\\','/')));
      if (scan.version !== request.version) invalid('This item changed. Reopen its menu before trying again.');
      if (request.action === 'trash') {
        const trashRoot=await this.trashRoot();
        const trash=await fs.opendir(trashRoot); let count=0;
        for await(const entry of trash) if(entry.isDirectory() && ++count>=200) invalid('Vade Trash has reached its 200-item limit. Restore entries before deleting more items.');
        const id=crypto.randomUUID(), directory=path.join(trashRoot,id);
        await fs.mkdir(directory,{mode:0o700});
        await fs.writeFile(path.join(directory,'entry.json'),JSON.stringify({projectId,worktreeId:request.worktreeId,relative:request.path}),{flag:'wx',mode:0o600});
        try { await fs.rename(source.target,path.join(directory,'data')); }
        catch(error){if(!await exists(path.join(directory,'data'))){await fs.unlink(path.join(directory,'entry.json')).catch(()=>{});await fs.rmdir(directory).catch(()=>{});}throw error;}
        return { path:request.path,restoreId:id };
      }
      let destination=request.destination;
      if(request.action==='duplicate') {
        const parsed=path.posix.parse(request.path);
        for(let count=1;count<=100;count++) { const candidate=path.posix.join(parsed.dir,`${parsed.name} copy${count===1?'':` ${count}`}${parsed.ext}`); const target=await this.files.ownedPath(projectId,request.worktreeId,candidate,true); if(!await exists(target.target)){destination=candidate;break;} }
      }
      if(typeof destination!=='string' || !destination || destination===request.path || destination.startsWith(request.path+'/')) invalid('Choose a new destination outside the source folder');
      const target=await this.files.ownedPath(projectId,request.worktreeId,destination,true);
      if(await exists(target.target)) invalid('The destination already exists; existing files are never overwritten');
      if(request.action==='rename') { await this.moveExclusive(source.target,target.target,scan.entries[0].directory); return {path:destination}; }
      for(const entry of scan.entries) {
        const from=path.join(source.target,entry.relative), to=path.join(target.target,entry.relative);
        if(entry.directory) await fs.mkdir(to,{mode:entry.mode}); else await fs.copyFile(from,to,constants.COPYFILE_EXCL);
      }
      return {path:destination};
    } catch(error) {
      if(error instanceof CliError) throw error;
      const code=(error as NodeJS.ErrnoException).code;
      invalid(code==='EEXIST' || code==='ENOTEMPTY' ? 'The destination already exists; no existing files were overwritten' : code==='EXDEV' ? 'This move crosses filesystem volumes and could not be completed. The source was preserved.' : 'The file operation could not be completed. Inspect the source and destination before trying again.');
    } finally { this.locks.delete(key); this.files.invalidate(); }
  }
}
