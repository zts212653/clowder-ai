#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function outsideFences(content, transform) {
  let fenced = false;
  return content
    .split(/(?<=\n)/u)
    .map((line) => {
      if (line.startsWith('```')) {
        fenced = !fenced;
        return line;
      }
      return fenced ? line : transform(line);
    })
    .join('');
}

function isMissingLocalLink(link, documentPath) {
  const path = link.split('#', 1)[0];
  if (!path || /^(?:https?:\/\/|mailto:|ftp:\/\/|tel:|cat-cafe:\/\/|\/)/u.test(path)) return false;
  if (['url', 'path', 'URL', 'PATH'].includes(path)) return false;
  if (path.includes('...') || path.includes('xxx') || path.includes('\\*')) return false;
  return !existsSync(resolve(dirname(documentPath), path));
}

/** The same exact transform is used for committed bytes and legacy-baseline comparison. */
export function projectPublicDeadLinks(content, documentPath) {
  const deadLinks = [];
  outsideFences(content, (line) => {
    for (const match of line.matchAll(/\[.*?\]\(([^)]+)\)/g)) {
      if (isMissingLocalLink(match[1], documentPath)) deadLinks.push(match[1]);
    }
    return line;
  });

  let projected = content;
  for (const link of new Set(deadLinks)) {
    const escaped = link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const image = new RegExp(`!\\[([^\\]]+)\\]\\(${escaped}(?:#[^)]*)?\\)`, 'g');
    const text = new RegExp(`\\[([^\\]]+)\\]\\(${escaped}(?:#[^)]*)?\\)`, 'g');
    projected = outsideFences(projected, (line) =>
      line.replace(image, (_, label) => `*(image: ${label})*`).replace(text, (_, label) => label),
    );
  }
  return { content: projected, deadLinks };
}

function* documents(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      // Exclude children of this tree, never directories in its absolute prefix.
      if (!['.git', 'node_modules', 'fixtures'].includes(entry.name)) yield* documents(path);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      yield path;
    }
  }
}

export function projectPublicDeadLinkTree(treeRoot) {
  const root = resolve(treeRoot);
  const report = [];
  for (const path of documents(root)) {
    const original = readFileSync(path, 'utf8');
    const result = projectPublicDeadLinks(original, path);
    for (const link of result.deadLinks) report.push(`  ⚠ ${relative(root, path)} → ${link}\n`);
    if (result.content !== original) writeFileSync(path, result.content);
  }
  return report.join('');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, reportPath] = process.argv.slice(2);
  if (!root || !reportPath) throw new Error('usage: project-public-dead-links.mjs <tree-root> <report-file>');
  writeFileSync(reportPath, projectPublicDeadLinkTree(root));
}
