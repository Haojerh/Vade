import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConversationImage } from '../../../shared/contracts.js';
import {
  conversationImageHeaders, conversationImageId, imageContentDigest, isCodexImageEnvelopeText, MAX_CONVERSATION_IMAGE_BYTES, MAX_CONVERSATION_PAGE_IMAGE_BYTES,
  MAX_MESSAGE_IMAGES, readRecordAt, readRecordedImage, recordedImageMimeType, recordedUserImages,
  stripImagePromptMarkers, verifyConversationImageId,
} from '../common/conversationImages.js';
import { AdeConversations, publicMessage } from '../../runtime/chat/conversation.js';
import type { SessionRecord } from '../../runtime/store.js';

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('0000000d49484452', 'hex'), Buffer.alloc(16, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 3)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(20, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBP', 'latin1'), Buffer.alloc(16, 2)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8');

const b64 = (bytes: Buffer) => bytes.toString('base64');

function claudeRow(content: unknown[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({ type: 'user', sessionId: 's', cwd: '/repo', uuid: 'prompt-uuid', timestamp: '2026-09-18T13:57:23.766Z', message: { role: 'user', content }, ...extra });
}

function codexRow(content: unknown[]) {
  return JSON.stringify({ type: 'response_item', timestamp: '2026-10-27T22:57:35.000Z', payload: { type: 'message', role: 'user', id: 'codex-uuid', content } });
}

function imageBlock(bytes: Buffer, mediaType = 'image/png') {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64(bytes) } };
}

test('Claude records the prompt image and strips its sent marker while the companion path stays private', () => {
  const line = claudeRow([{ type: 'text', text: '[Image #1] fix the arrow too big issue' }, imageBlock(PNG)]);
  const { images, markerNumbers } = recordedUserImages('claude', line, 'src_abc', 42);
  assert.deepEqual(markerNumbers, [1]);
  assert.equal(images.length, 1);
  assert.equal(images[0]!.mimeType, 'image/png');
  assert.equal(images[0]!.bytes, PNG.length);
  assert.equal(images[0]!.id, conversationImageId('src_abc', 42, 0, b64(PNG)));
  assert.ok(!JSON.stringify(images).includes('data:'));
  assert.equal(stripImagePromptMarkers('[Image #1] fix the arrow too big issue', markerNumbers), 'fix the arrow too big issue');
  const message = publicMessage({ provider: 'claude', providerThreadId: 's' } as SessionRecord, line, 'src_abc', 42);
  assert.equal(message?.text, 'fix the arrow too big issue');
  assert.deepEqual(message?.images?.map(image => image.id), [images[0]!.id]);
});

test('Claude image companion rows and tool result images never become public attachments', () => {
  const companion = JSON.stringify({ type: 'user', isMeta: true, sessionId: 's', cwd: '/repo', uuid: 'companion', message: { role: 'user', content: [{ type: 'text', text: '[Image: source: C:\\Users\\User\\Pictures\\shot.png]' }] } });
  assert.deepEqual(recordedUserImages('claude', companion, 'src_abc', 1).images, []);
  const toolResult = claudeRow([{ type: 'tool_result', tool_use_id: 'toolu_1', content: [imageBlock(JPEG)] }]);
  assert.deepEqual(recordedUserImages('claude', toolResult, 'src_abc', 2).images, []);
  assert.equal(publicMessage({ provider: 'claude', providerThreadId: 's' } as SessionRecord, toolResult, 'src_abc', 2), null);
  const metaPrompt = claudeRow([{ type: 'text', text: 'injected' }, imageBlock(PNG)], { isMeta: true });
  assert.deepEqual(recordedUserImages('claude', metaPrompt, 'src_abc', 3).images, []);
});

test('Codex input_image data URLs are projected while the recorded host path never reaches public text', () => {
  const line = codexRow([
    { type: 'input_text', text: '<image name=[Image #1] path="C:\\Users\\User\\AppData\\Local\\Temp\\orca-paste-1.png">' },
    { type: 'input_image', image_url: `data:image/png;base64,${b64(PNG)}` },
    { type: 'input_text', text: '</image>' },
    { type: 'input_text', text: '[Image #1] when hovering edit and delete, the bg too weird.' },
  ]);
  assert.ok(isCodexImageEnvelopeText('<image name=[Image #1] path="C:\\a\\b.png">'));
  assert.ok(isCodexImageEnvelopeText('</image>'));
  assert.ok(!isCodexImageEnvelopeText('<image name=[Image #1]>'));
  assert.ok(!isCodexImageEnvelopeText('ordinary <image prose>'));
  const message = publicMessage({ provider: 'codex', providerThreadId: 's' } as SessionRecord, line, 'src_xyz', 7);
  assert.equal(message?.text, 'when hovering edit and delete, the bg too weird.');
  assert.ok(!message!.text.includes('orca-paste'));
  assert.ok(!message!.text.includes('C:\\'));
  assert.deepEqual(message?.images?.map(image => image.mimeType), ['image/png']);
});

test('unsupported, oversized, mismatched and malformed recorded images are rejected rather than guessed', () => {
  const svg = claudeRow([{ type: 'text', text: 'here' }, imageBlock(SVG, 'image/svg+xml')]);
  assert.deepEqual(recordedUserImages('claude', svg, 'src', 1).images, []);
  // A declared image type cannot rescue bytes whose signature is not a supported image.
  const lying = claudeRow([{ type: 'text', text: 'here' }, imageBlock(Buffer.from('not an image at all'), 'image/png')]);
  assert.deepEqual(recordedUserImages('claude', lying, 'src', 1).images, []);
  const oversized = claudeRow([{ type: 'text', text: 'here' }, imageBlock(Buffer.concat([PNG, Buffer.alloc(MAX_CONVERSATION_IMAGE_BYTES)]))]);
  assert.deepEqual(recordedUserImages('claude', oversized, 'src', 1).images, []);
  const malformed = claudeRow([{ type: 'text', text: 'here' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '!!!!' } }]);
  assert.deepEqual(recordedUserImages('claude', malformed, 'src', 1).images, []);
  const remoteUrl = codexRow([{ type: 'input_text', text: 'see' }, { type: 'input_image', image_url: 'https://example.test/a.png' }]);
  assert.deepEqual(recordedUserImages('codex', remoteUrl, 'src', 1).images, []);
  const pathSource = claudeRow([{ type: 'text', text: 'here' }, { type: 'image', source: { type: 'path', path: '/tmp/a.png' } }]);
  assert.deepEqual(recordedUserImages('claude', pathSource, 'src', 1).images, []);
});

test('a turn carries at most four recorded images and preserves recorded marker positions', () => {
  const line = claudeRow([{ type: 'text', text: '[Image #1] [Image #2] [Image #3] [Image #4] [Image #5] compare' },
    imageBlock(PNG), imageBlock(JPEG), imageBlock(GIF), imageBlock(WEBP), imageBlock(PNG)]);
  const { images, markerNumbers } = recordedUserImages('claude', line, 'src', 3);
  assert.equal(images.length, MAX_MESSAGE_IMAGES);
  assert.deepEqual(images.map(image => image.mimeType), ['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  assert.deepEqual(images.map(image => image.id), [PNG, JPEG, GIF, WEBP].map((bytes, index) => conversationImageId('src', 3, index, b64(bytes))));
  assert.deepEqual(markerNumbers, [1, 2, 3, 4]);
  assert.equal(stripImagePromptMarkers('[Image #1] [Image #2] [Image #3] [Image #4] [Image #5] compare', markerNumbers), '[Image #5] compare');
});

test('image IDs bind the page source identity, the record offset and the recorded content', () => {
  const content = b64(PNG);
  const id = conversationImageId('src_abc', 1024, 2, content);
  const contentDigest = imageContentDigest(content);
  assert.deepEqual(verifyConversationImageId(id, 'src_abc'), { offset: 1024, index: 2, contentDigest });
  assert.equal(verifyConversationImageId(id, 'src_other'), null);
  // Same offset and position but different recorded bytes is a different locator.
  assert.notEqual(conversationImageId('src_abc', 1024, 2, b64(JPEG)), id);
  assert.equal(verifyConversationImageId(conversationImageId('src_abc', 1024, 2, b64(JPEG)), 'src_abc')?.contentDigest, imageContentDigest(b64(JPEG)));
  // Moving any part of the locator while keeping its token is refused.
  const offset36 = (1024).toString(36);
  const token = id.slice(`img.${offset36}.2.${contentDigest}.`.length);
  assert.equal(token.length, 20);
  assert.deepEqual(verifyConversationImageId(`img.${offset36}.2.${contentDigest}.${token}`, 'src_abc'), { offset: 1024, index: 2, contentDigest });
  assert.equal(verifyConversationImageId(`img.${(1025).toString(36)}.2.${contentDigest}.${token}`, 'src_abc'), null);
  assert.equal(verifyConversationImageId(`img.${offset36}.3.${contentDigest}.${token}`, 'src_abc'), null);
  assert.equal(verifyConversationImageId(`img.${offset36}.2.${imageContentDigest(b64(JPEG))}.${token}`, 'src_abc'), null);
  assert.equal(verifyConversationImageId('img.not-a-token', 'src_abc'), null);
  assert.equal(verifyConversationImageId(`img.${offset36}.2.${contentDigest}.00000000000000000000`, 'src_abc'), null);
  assert.equal(verifyConversationImageId(`img.${offset36}.4.${contentDigest}.${token}`, 'src_abc'), null);
  assert.equal(verifyConversationImageId(`img_${offset36}-2-${contentDigest}-${token}`, 'src_abc'), null);
});

test('recorded image bytes are re-read only from a complete bounded row at a line boundary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-image-row-'));
  try {
    const file = path.join(root, 'session.jsonl');
    const first = claudeRow([{ type: 'text', text: 'first' }]);
    const second = claudeRow([{ type: 'text', text: '[Image #1] second' }, imageBlock(JPEG)]);
    fs.writeFileSync(file, `${first}\n${second}\n`);
    const secondOffset = Buffer.byteLength(`${first}\n`);
    assert.equal(readRecordAt(file, 0), first);
    assert.equal(readRecordAt(file, secondOffset), second);
    assert.equal(readRecordAt(file, 1), null, 'an interior offset is not a record start');
    assert.equal(readRecordAt(file, 10_000), null);
    assert.deepEqual(readRecordedImage('claude', readRecordAt(file, secondOffset)!, 0), { mimeType: 'image/jpeg', bytes: JPEG });
    assert.equal(readRecordedImage('claude', readRecordAt(file, secondOffset)!, 1), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recorded image signatures are authoritative and cover only PNG, JPEG, GIF and WebP', () => {
  assert.equal(recordedImageMimeType(PNG), 'image/png');
  assert.equal(recordedImageMimeType(JPEG), 'image/jpeg');
  assert.equal(recordedImageMimeType(GIF), 'image/gif');
  assert.equal(recordedImageMimeType(WEBP), 'image/webp');
  assert.equal(recordedImageMimeType(SVG), null);
  assert.equal(recordedImageMimeType(Buffer.alloc(0)), null);
});

test('recorded image responses declare the sniffed type and forbid sniffing, scripting and reuse', () => {
  const headers = conversationImageHeaders({ mimeType: 'image/png', bytes: PNG });
  assert.equal(headers['Content-Type'], 'image/png');
  assert.equal(headers['Content-Length'], String(PNG.length));
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.match(headers['Content-Security-Policy']!, /default-src 'none'/);
  assert.match(headers['Content-Security-Policy']!, /sandbox/);
  assert.equal(headers['Cross-Origin-Resource-Policy'], 'same-origin');
  assert.ok(!Object.values(headers).some(value => /https?:|data:/.test(value)));
  assert.equal(conversationImageHeaders({ mimeType: 'image/webp', bytes: WEBP })['Content-Length'], String(WEBP.length));
});

test('providers without a verified transcript image record project no attachments', () => {
  const row = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [imageBlock(PNG), { type: 'input_text', text: 'hi' }] } });
  // DSH conversations carry no recorded image events, and Antigravity keeps user turns
  // in protobuf blobs. Their staged attachment references are projected separately from
  // the public text, never from a fabricated image block.
  for (const provider of ['dsh', 'antigravity']) {
    assert.deepEqual(recordedUserImages(provider, row, 'src', 0).images, [], provider);
  }
});

test('OpenCode-family attachment parts project as recorded images and drop their placeholder', () => {
  const record = { provider: 'kilo' } as SessionRecord;
  const row = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [
    { type: 'text', text: '\n[Image 1] dfe' },
    { type: 'input_image', image_url: `data:image/jpeg;base64,${b64(JPEG)}` },
  ] } });
  const { images, markerNumbers } = recordedUserImages('kilo', row, 'src', 7);
  assert.deepEqual(markerNumbers, [1]);
  assert.deepEqual(images.map(image => [image.mimeType, image.bytes]), [['image/jpeg', JPEG.length]]);
  const message = publicMessage(record, row, 'src', 7);
  assert.equal(message?.text, 'dfe');
  assert.equal(message?.images?.length, 1);
  for (const provider of ['opencode', 'opencode2', 'kilocode']) {
    assert.equal(recordedUserImages(provider, row, 'src', 7).images.length, 1, provider);
  }
  // A remote or host-path attachment is never a served image.
  const remote = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [
    { type: 'input_image', image_url: 'https://example.test/a.png' }, { type: 'text', text: 'hi' },
  ] } });
  assert.deepEqual(recordedUserImages('opencode2', remote, 'src', 1).images, []);
});

test('image-only public turns render while foreign sessions and sidechains remain excluded',()=>{
  const record={provider:'claude',providerThreadId:'exact'} as SessionRecord;
  const line=claudeRow([imageBlock(PNG)],{sessionId:'exact'});
  const message=publicMessage(record,line,'src',0);
  assert.ok(message);assert.equal(message.role,'user');assert.equal(message.text,'');assert.equal(message.images?.length,1);
  assert.equal(publicMessage(record,claudeRow([imageBlock(PNG)],{sessionId:'foreign'}),'src',0),null);
  assert.equal(publicMessage(record,claudeRow([imageBlock(PNG)],{sessionId:'exact',isSidechain:true}),'src',0),null);
  const codex=publicMessage({provider:'codex'} as SessionRecord,codexRow([{type:'input_image',image_url:`data:image/png;base64,${b64(PNG)}`}]),'codex-src',0);
  assert.ok(codex);assert.equal(codex.text,'');assert.equal(codex.images?.length,1);
});

test('the exact bound session serves recorded bytes and refuses a replaced transcript or a foreign locator', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-image-session-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  try {
    const id = '84daefda-a420-49d5-9e7e-e61680167076';
    const cwd = path.join(root, 'work');
    fs.mkdirSync(cwd, { recursive: true });
    const projectDir = path.join(root, 'projects', 'encoded');
    fs.mkdirSync(projectDir, { recursive: true });
    const file = path.join(projectDir, `${id}.jsonl`);
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'user', sessionId: id, cwd, uuid: 'seed', timestamp: '2026-09-18T13:57:20.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
      claudeRow([{ type: 'text', text: '[Image #1] look at this' }, imageBlock(PNG)], { sessionId: id, cwd }),
    ].join('\n') + '\n');
    process.env.CLAUDE_CONFIG_DIR = root;
    const conversations = new AdeConversations(path.join(root, 'ade'));
    const record = { projectId: 'p', id: 'n', cwd, sourceCwd: cwd, provider: 'claude', providerThreadId: id } as SessionRecord;

    const page = (await conversations.read(record)).data!;
    const withImage = page.messages.find(message => message.images?.length);
    assert.ok(withImage, 'the recorded prompt image is projected');
    assert.equal(withImage.text, 'look at this');
    const image = withImage.images![0]!;
    assert.equal(image.mimeType, 'image/png');
    assert.equal(image.bytes, PNG.length);

    assert.deepEqual(conversations.image(record, page.sourceIdentity, image.id), { mimeType: 'image/png', bytes: PNG });
    assert.throws(() => conversations.image(record, 'src_foreign', image.id), /not available/);
    const tampered = image.id.replace('.0.', '.1.');
    assert.notEqual(tampered, image.id);
    assert.throws(() => conversations.image(record, page.sourceIdentity, tampered), /not available/);

    // Appending later turns keeps the same binding, so already rendered images stay valid.
    fs.appendFileSync(file, JSON.stringify({ type: 'user', sessionId: id, cwd, uuid: 'later', timestamp: '2026-09-18T13:58:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'more' }] } }) + '\n');
    const after = (await conversations.read(record)).data!;
    assert.equal(after.sourceIdentity, page.sourceIdentity);
    assert.deepEqual(conversations.image(record, page.sourceIdentity, image.id), { mimeType: 'image/png', bytes: PNG });

    for(const extra of [{sessionId:'foreign'},{sessionId:id,isSidechain:true}]){
      const offset=fs.statSync(file).size;
      fs.appendFileSync(file,claudeRow([{type:'text',text:'Not public'},imageBlock(PNG)],{...extra,cwd,uuid:'private'})+'\n');
      const token=conversationImageId(page.sourceIdentity,offset,0,b64(PNG));
      assert.throws(()=>conversations.image(record,page.sourceIdentity,token),/public session/);
    }

    // Replacing the transcript file changes the binding, so the old locator cannot resolve.
    const replacement = path.join(root, 'replacement.jsonl');
    fs.writeFileSync(replacement, fs.readFileSync(file));
    fs.renameSync(replacement, file);
    assert.throws(() => conversations.image(record, page.sourceIdentity, image.id), /Conversation changed/);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a row rewritten in place never serves different bytes under an old image ID', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-image-stale-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  try {
    const id = '77777777-6666-4555-8444-333333333333';
    const cwd = path.join(root, 'work');
    fs.mkdirSync(cwd, { recursive: true });
    const projectDir = path.join(root, 'projects', 'encoded');
    fs.mkdirSync(projectDir, { recursive: true });
    const file = path.join(projectDir, `${id}.jsonl`);
    const row = (bytes: Buffer) => claudeRow([{ type: 'text', text: '[Image #1] screenshot' }, imageBlock(bytes)], { sessionId: id, cwd, uuid: 'prompt' });
    fs.writeFileSync(file, `${row(PNG)}\n`);
    process.env.CLAUDE_CONFIG_DIR = root;
    const conversations = new AdeConversations(path.join(root, 'ade'));
    const record = { projectId: 'p', id: 'n', cwd, sourceCwd: cwd, provider: 'claude', providerThreadId: id } as SessionRecord;

    const page = (await conversations.read(record)).data!;
    const stale = page.messages.find(message => message.images?.length)!.images![0]!;
    assert.deepEqual(conversations.image(record, page.sourceIdentity, stale.id), { mimeType: 'image/png', bytes: PNG });

    // Same file, same inode, same offset: only the recorded bytes change.
    const other = Buffer.concat([PNG, Buffer.from('replacement-image-bytes')]);
    fs.writeFileSync(file, `${row(other)}\n`);
    const rewritten = (await conversations.read(record)).data!;
    assert.equal(rewritten.sourceIdentity, page.sourceIdentity, 'an in-place rewrite keeps the file binding');
    assert.throws(() => conversations.image(record, page.sourceIdentity, stale.id), /recorded image changed/);

    const fresh = rewritten.messages.find(message => message.images?.length)!.images![0]!;
    assert.notEqual(fresh.id, stale.id, 'a rewritten row mints a new locator');
    assert.deepEqual(conversations.image(record, rewritten.sourceIdentity, fresh.id), { mimeType: 'image/png', bytes: other });
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a page budget drops later images and keeps their literal marker instead of a dangling chip', () => {
  const record = { provider: 'claude', providerThreadId: 's' } as SessionRecord;
  const big = Buffer.concat([PNG, Buffer.alloc(900 * 1024)]);
  const line = claudeRow([{ type: 'text', text: '[Image #1] keep me' }, imageBlock(big)]);
  const budget = { remaining: MAX_CONVERSATION_PAGE_IMAGE_BYTES };
  const first = publicMessage(record, line, 'src', 10, budget);
  assert.equal(first?.text, 'keep me');
  assert.equal(first?.images?.length, 1);
  assert.equal(budget.remaining, MAX_CONVERSATION_PAGE_IMAGE_BYTES - big.length);
  const later = claudeRow([{ type: 'text', text: '[Image #1] drop me' }, imageBlock(big)]);
  const dropped = publicMessage(record, later, 'src', 20, { remaining: big.length - 1 });
  assert.equal(dropped?.text, '[Image #1] drop me', 'an unavailable image keeps its recorded marker');
  assert.equal(dropped?.images, undefined);
  assert.equal(publicMessage(record, later, 'src', 20, { remaining: big.length })?.images?.length, 1);
});

test('an image turn whose serialized row exceeds one MiB is still projected and served', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-image-large-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  try {
    const id = '99999999-8888-4777-8666-555555555555';
    const cwd = path.join(root, 'work');
    fs.mkdirSync(cwd, { recursive: true });
    const projectDir = path.join(root, 'projects', 'encoded');
    fs.mkdirSync(projectDir, { recursive: true });
    // ~900 KiB of image bytes serialize to a >1 MiB JSON row.
    const large = Buffer.concat([PNG, Buffer.alloc(900 * 1024, 9)]);
    const row = claudeRow([{ type: 'text', text: '[Image #1] large screenshot' }, imageBlock(large)], { sessionId: id, cwd, uuid: 'large' });
    assert.ok(Buffer.byteLength(row) > 1024 * 1024, 'the recorded row really is larger than one MiB');
    fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), [
      JSON.stringify({ type: 'user', sessionId: id, cwd, uuid: 'seed', timestamp: '2026-09-18T13:57:20.000Z', message: { role: 'user', content: [{ type: 'text', text: 'seed' }] } }),
      row,
    ].join('\n') + '\n');
    process.env.CLAUDE_CONFIG_DIR = root;
    const conversations = new AdeConversations(path.join(root, 'ade'));
    const record = { projectId: 'p', id: 'n', cwd, sourceCwd: cwd, provider: 'claude', providerThreadId: id } as SessionRecord;
    const page = (await conversations.read(record)).data!;
    const message = page.messages.find(item => item.images?.length);
    assert.ok(message, 'the large image turn survives the page read');
    assert.equal(message.text, 'large screenshot');
    assert.equal(message.images![0]!.bytes, large.length);
    assert.deepEqual(conversations.image(record, page.sourceIdentity, message.images![0]!.id), { mimeType: 'image/png', bytes: large });
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a page projects only images its bounded read window can reach', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ade-image-window-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  try {
    const id = '11111111-2222-4333-8444-555555555555';
    const cwd = path.join(root, 'work');
    fs.mkdirSync(cwd, { recursive: true });
    const projectDir = path.join(root, 'projects', 'encoded');
    fs.mkdirSync(projectDir, { recursive: true });
    const rows: string[] = [JSON.stringify({ type: 'user', sessionId: id, cwd, uuid: 'seed', timestamp: '2026-09-18T13:57:20.000Z', message: { role: 'user', content: [{ type: 'text', text: 'seed' }] } })];
    for (let index = 0; index < 6; index++) rows.push(claudeRow([{ type: 'text', text: `[Image #1] turn ${index}` }, imageBlock(PNG)], { sessionId: id, cwd, uuid: `uuid-${index}` }));
    fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), rows.join('\n') + '\n');
    process.env.CLAUDE_CONFIG_DIR = root;
    const conversations = new AdeConversations(path.join(root, 'ade'));
    const record = { projectId: 'p', id: 'n', cwd, sourceCwd: cwd, provider: 'claude', providerThreadId: id } as SessionRecord;
    const page = (await conversations.read(record, { limit: 200 })).data!;
    const images = page.messages.flatMap(message => message.images ?? []);
    assert.equal(images.length, 6);
    assert.ok(images.every(image => image.mimeType === 'image/png' && image.bytes === PNG.length));
    assert.ok(images.reduce((sum, image) => sum + image.bytes, 0) <= MAX_CONVERSATION_PAGE_IMAGE_BYTES);
    // Every projected image resolves to its own recorded bytes through the bound route.
    for (const image of images) assert.deepEqual(conversations.image(record, page.sourceIdentity, image.id), { mimeType: 'image/png', bytes: PNG });
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
