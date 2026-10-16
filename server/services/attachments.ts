import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { MAX_ATTACHMENT_BYTES, MAX_MESSAGE_ATTACHMENTS, MAX_MESSAGE_ATTACHMENT_BYTES } from '../../shared/contracts.js';
import { CliError } from '../integrations/cli.js';

const imageSignatures: Record<string, (bytes: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
  'image/jpeg': (b) => b[0] === 255 && b[1] === 216 && b[2] === 255,
  'image/gif': (b) => /^GIF8[79]a$/.test(b.subarray(0, 6).toString('ascii')),
  'image/webp': (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
};

export function decodeAttachments(input: unknown): { name: string; mimeType: string; bytes: Buffer }[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAX_MESSAGE_ATTACHMENTS) {
    throw new CliError('INVALID_ARGUMENT', 'Attach up to 8 files');
  }
  let total = 0;
  return input.map((item) => {
    if (!item || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 200 ||
      typeof item.mimeType !== 'string' || item.mimeType.length > 100 || typeof item.dataBase64 !== 'string' ||
      !item.dataBase64.length || item.dataBase64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 ||
      item.dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.dataBase64)) {
      throw new CliError('INVALID_ARGUMENT', 'Invalid attachment name, type, or base64 content');
    }
    const bytes = Buffer.from(item.dataBase64, 'base64');
    if (bytes.toString('base64') !== item.dataBase64) throw new CliError('INVALID_ARGUMENT', 'Invalid base64 attachment');
    total += bytes.length;
    if (bytes.length > MAX_ATTACHMENT_BYTES || total > MAX_MESSAGE_ATTACHMENT_BYTES) {
      throw new CliError('INVALID_ARGUMENT', 'Files must be at most 5 MiB each and 20 MiB combined');
    }
    if (item.mimeType.startsWith('image/') && !imageSignatures[item.mimeType]?.(bytes)) {
      throw new CliError('INVALID_ARGUMENT', 'Images must contain valid PNG, JPEG, GIF, or WebP data');
    }
    return { name: item.name.replace(/[\x00-\x1f\x7f]/g, '_'), mimeType: item.mimeType, bytes };
  });
}

// Retain accepted files for asynchronous agent reads; sweep on subsequent sends.
const busyStores = new Set<string>();
export async function storeAttachments(files: ReturnType<typeof decodeAttachments>, root = path.join(os.tmpdir(), 'orca-visualization-attachments')) {
  if (busyStores.has(root)) throw new CliError('RATE_LIMITED', 'Another upload is being stored; try again shortly');
  busyStores.add(root);
  try { return await writeAttachments(files, root); }
  finally { busyStores.delete(root); }
}

async function writeAttachments(files: ReturnType<typeof decodeAttachments>, root: string) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(root)).isSymbolicLink()) throw new CliError('INVALID_ARGUMENT', 'Invalid attachment store');
  const entries = await fs.readdir(root, { withFileTypes: true });
  let storedBytes = 0;
  let count = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9-]{36}\.[a-z0-9]{1,10}$/.test(entry.name)) continue;
    const file = path.join(root, entry.name);
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) await fs.unlink(file);
    else { storedBytes += stat.size; count++; }
  }
  if (count + files.length > 256 || storedBytes + files.reduce((sum, file) => sum + file.bytes.length, 0) > 200 * 1024 * 1024) {
    throw new CliError('RATE_LIMITED', 'Attachment storage is full; try again after older uploads expire');
  }
  const stored: { name: string; path: string; image: boolean }[] = [];
  for (const file of files) {
    const image = file.mimeType.startsWith('image/');
    const extension = image ? ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[file.mimeType])! :
      (/\.([a-z0-9]{1,10})$/i.exec(file.name)?.[1].toLowerCase() || 'bin');
    const target = path.join(root, `${crypto.randomUUID()}.${extension}`);
    await fs.writeFile(target, file.bytes, { flag: 'wx', mode: 0o600 });
    stored.push({ name: file.name, path: target, image });
  }
  return stored;
}

// Mirrors Orca's agent-image-paste: verified raw-path image attachment agents;
// remaining providers receive @file references rather than a fabricated image claim.
const nativeImageAgents = new Set(['codex', 'claude', 'openclaude', 'gemini', 'cursor', 'copilot', 'droid', 'grok']);
export function usesNativeImageAttachment(provider: string | null, file: { image: boolean }): boolean {
  return file.image && nativeImageAgents.has(provider || '');
}
export function attachmentReference(file: { path: string }): string {
  return /\s/.test(file.path) ? `@"${file.path}"` : `@${file.path}`;
}
export function attachmentPaste(provider: string | null, file: { path: string; image: boolean }): string {
  const filePath = /\s/.test(file.path) ? `"${file.path}"` : file.path;
  const reference = usesNativeImageAttachment(provider, file) ? filePath : attachmentReference(file);
  // Keep the image path paste intact for native attachment detection. Paste the
  // line break separately inside its own frame so it cannot submit the prompt.
  return `\x1b[200~${reference}\x1b[201~\x1b[200~\n\x1b[201~`;
}
