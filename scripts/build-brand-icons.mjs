import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';

// The existing vector mark is the single source for desktop branding.
const svg = await readFile(new URL('../src/assets/brand/vade.svg', import.meta.url), 'utf8');
const directory = new URL('../resources/branding/', import.meta.url);
await mkdir(directory, { recursive: true });
const render = size => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
await writeFile(new URL('vade.png', directory), render(1024));
await writeFile(new URL('../public/vade-notification.png', import.meta.url), render(128));

// Individually render each Windows shortcut size instead of enlarging a bitmap.
const sizes = [16, 24, 32, 48, 64, 128, 256], images = sizes.map(render);
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, index) => {
  const entry = 6 + index * 16;
  header[entry] = size === 256 ? 0 : size; header[entry + 1] = header[entry];
  header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[index].length, entry + 8); header.writeUInt32LE(offset, entry + 12);
  offset += images[index].length;
});
await writeFile(new URL('vade.ico', directory), Buffer.concat([header, ...images]));
