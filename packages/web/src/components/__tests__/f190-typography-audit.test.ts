import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { typographyViolations } from './f190-typography-audit';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cafe-typography-audit-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function source(path: string, body: string) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
}

it('retains the five file-icon letter sizes without exempting ordinary text in either file', () => {
  source(
    'components/chat-references/chat-reference.module.css',
    '.officeIcon{font-size:8.5px}.pdfIcon{font-size:5.5px}.big .pdfIcon{font-size:9px}' +
      '.grid .big .officeIcon{font-size:9px}.label{font-size:8.5px}',
  );
  source('components/artifacts/work-cover.css', '.work-cover-office{font-size:8px}.caption{font-size:8px}');
  const violations = typographyViolations(root);
  expect(violations).toHaveLength(2);
  expect(violations.some((value) => value.includes('chat-reference.module.css'))).toBe(true);
  expect(violations.some((value) => value.includes('work-cover.css'))).toBe(true);
});

it('rejects an unapproved literal even in an approved icon selector', () => {
  source('components/chat-references/chat-reference.module.css', '.officeIcon{font-size:10px}');
  expect(typographyViolations(root)).toHaveLength(1);
});

it('exempts only the standalone document path and continues scanning other generated HTML', () => {
  const html = 'export const html = `<!doctype html><style>h1{font-size:26px}</style>`;';
  source('components/onboarding-demo/demo-deliverable.ts', html);
  source('components/onboarding-demo/another-document.ts', html);
  expect(typographyViolations(root)).toEqual(['src/components/onboarding-demo/another-document.ts: font-size:2']);
});
