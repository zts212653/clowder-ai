#!/usr/bin/env node
// SVG → 2x PNG renderer (烁烁 · mem0 proxy figures)
// Usage: node render.mjs <file1.svg> [file2.svg ...]   (no args = render all proxy-fig*.svg)
import sharp from 'sharp';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCALE = 2; // 2x retina

function vb(svg) {
  const m = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  if (m) return { w: +m[1], h: +m[2] };
  const w = svg.match(/width="([\d.]+)"/), h = svg.match(/height="([\d.]+)"/);
  return { w: +w[1], h: +h[1] };
}

async function render(file) {
  const path = join(here, file);
  const svg = readFileSync(path, 'utf8');
  const { w, h } = vb(svg);
  const targetW = Math.round(w * SCALE), targetH = Math.round(h * SCALE);
  const out = path.replace(/\.svg$/, '.png');
  await sharp(Buffer.from(svg), { density: 96 * SCALE })
    .resize(targetW, targetH, { fit: 'fill' })
    .png({ compressionLevel: 9 })
    .toFile(out);
  const meta = await sharp(out).metadata();
  console.log(`✓ ${basename(out)}  ${meta.width}x${meta.height}  (target ${targetW}x${targetH})`);
}

const args = process.argv.slice(2);
const files = args.length ? args : readdirSync(here).filter(f => /^proxy-fig.*\.svg$/.test(f)).sort();
for (const f of files) await render(f);
