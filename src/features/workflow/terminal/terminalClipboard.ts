import {MAX_MESSAGE_ATTACHMENTS,MAX_ATTACHMENT_BYTES,MAX_MESSAGE_ATTACHMENT_BYTES} from '../../../../shared/contracts';

/** Prefer image bytes over their incidental text representation. One format per item. */
export async function readTerminalClipboard(clipboard:Pick<Clipboard,'read'|'readText'>):Promise<{files:File[];text:string}> {
  if(typeof clipboard.read!=='function')return {files:[],text:await clipboard.readText()};
  const items=await clipboard.read(),files:File[]=[];let bytes=0;
  for(const item of items){
    const type=item.types.find(type=>type==='image/png')??item.types.find(type=>type.startsWith('image/'));
    if(type){
      if(files.length>=MAX_MESSAGE_ATTACHMENTS)throw Error('Paste up to 8 images.');
      const blob=await item.getType(type);bytes+=blob.size;
      if(!blob.size||blob.size>MAX_ATTACHMENT_BYTES||bytes>MAX_MESSAGE_ATTACHMENT_BYTES)throw Error('Images must be non-empty, at most 5 MiB each and 20 MiB combined.');
      files.push(new File([blob],`clipboard-${files.length+1}.${type.split('/')[1]}`,{type}));
    }
  }
  if(files.length)return {files,text:''};
  for(const item of items)if(item.types.includes('text/plain'))return {files:[],text:await (await item.getType('text/plain')).text()};
  return {files:[],text:''};
}
