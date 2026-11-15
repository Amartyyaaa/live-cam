#!/usr/bin/env node
// Builds public/icons.svg — an SVG sprite of the Lucide icons the UI uses.
//
//   npm pack lucide-static && tar -xzf lucide-static-*.tgz
//   node scripts/build-sprite.mjs ./package/icons
//
// Lucide is ISC-licensed (https://lucide.dev). The generated sprite is
// committed, so this only needs to run when the icon list changes.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ICONS = [
  'video', 'video-off', 'mic', 'mic-off', 'message-circle', 'arrow-right', 'arrow-left', 'x', 'flag',
  'settings', 'send-horizontal', 'switch-camera', 'globe', 'shield-check', 'zap', 'venetian-mask', 'eye',
  'house', 'chevron-down', 'chevron-left', 'chevron-right', 'plus', 'earth', 'sparkles', 'user-round',
  'circle-alert', 'square', 'refresh-cw', 'ban', 'languages',
];

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const iconsDir = process.argv[2];
if (!iconsDir) {
  console.error('Usage: node scripts/build-sprite.mjs <path to lucide-static/icons>');
  process.exit(1);
}

const symbols = ICONS.map((name) => {
  const svg = readFileSync(join(iconsDir, `${name}.svg`), 'utf8');
  const inner = svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/\s*\n\s*/g, '')
    .trim();
  return `<symbol id="i-${name}" viewBox="0 0 24 24">${inner}</symbol>`;
});

const sprite =
  '<svg xmlns="http://www.w3.org/2000/svg">\n' +
  '<!-- Icons from Lucide (https://lucide.dev), ISC License, Copyright (c) Lucide Contributors -->\n' +
  symbols.join('\n') +
  '\n</svg>\n';

writeFileSync(join(root, 'public', 'icons.svg'), sprite);
console.log(`Wrote public/icons.svg with ${symbols.length} icons`);
