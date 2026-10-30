import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConversationImage } from '../../shared/contracts';
import { ConversationImages, conversationImageLabel, conversationImageUrl } from '../features/workflow/chat/ConversationImages';

const images: ConversationImage[] = [
  { id: 'img.sg.0.AbCdEfGhIjKl.MnOpQrStUvWxYz012345', mimeType: 'image/png', bytes: 2048 },
  { id: 'img.sg.1.ZyXwVuTsRqPo.NmLkJiHgFeDcBa987654', mimeType: 'image/jpeg', bytes: 4096 },
];

const render = (props: Parameters<typeof ConversationImages>[0]) => renderToStaticMarkup(createElement(ConversationImages, props));

test('recorded images resolve through the bounded node route with opaque tokens only', () => {
  const url = conversationImageUrl('proj 1', 'node/2', 'src_abc', images[0]!);
  assert.equal(url, `/api/projects/proj%201/nodes/node%2F2/conversation-image?source=src_abc&id=${encodeURIComponent(images[0]!.id)}`);
  assert.ok(url.startsWith('/api/projects/'), 'the browser never receives an absolute or remote image URL');
  assert.ok(!/https?:|data:|file:|[A-Za-z]:\\/.test(url));
});

test('image labels stay explicit about which recorded attachment is shown', () => {
  assert.equal(conversationImageLabel(0, 1), 'Your image');
  assert.equal(conversationImageLabel(0, 2), 'Your image 1 of 2');
  assert.equal(conversationImageLabel(1, 2), 'Your image 2 of 2');
});

test('a turn without recorded images renders nothing at all', () => {
  assert.equal(render({ projectId: 'p', nodeId: 'n', source: 'src', images: undefined }), '');
  assert.equal(render({ projectId: 'p', nodeId: 'n', source: 'src', images: [] }), '');
});

test('recorded images render lazy, bounded previews with accessible open buttons', () => {
  const html = render({ projectId: 'p', nodeId: 'n', source: 'src', images });
  assert.equal(html.match(/<img /g)?.length, 2, 'one preview per recorded image, no extra fetch target');
  assert.equal(html.match(/loading="lazy"/g)?.length, 2);
  assert.equal(html.match(/decoding="async"/g)?.length, 2);
  assert.equal(html.match(/aria-label="Open your image \d of 2"/g)?.length, 2);
  assert.match(html, /alt="Your image 1 of 2"/);
  assert.match(html, /alt="Your image 2 of 2"/);
  assert.match(html, /aria-label="Attached images"/);
  assert.match(html, new RegExp(`src="/api/projects/p/nodes/n/conversation-image\\?source=src&amp;id=${encodeURIComponent(images[0]!.id)}"`));
  assert.ok(!/<dialog/.test(html), 'the lightbox stays closed until the user opens an image');
});

test('preview markup never carries a host path, remote URL or inline image payload', () => {
  const html = render({ projectId: 'p', nodeId: 'n', source: 'src', images });
  assert.ok(!html.includes('data:image'), 'recorded base64 is never inlined into markup');
  assert.ok(!/https?:\/\//.test(html));
  assert.ok(!/[A-Za-z]:\\/.test(html), 'no Windows host path leaks into the browser');
  assert.ok(!html.includes('/tmp/'), 'no POSIX host path leaks into the browser');
});

test('a single recorded image uses the singular label', () => {
  const html = render({ projectId: 'p', nodeId: 'n', source: 'src', images: [images[0]!] });
  assert.match(html, /alt="Your image"/);
  assert.match(html, /aria-label="Open your image"/);
  assert.ok(!html.includes('of 1'));
});
