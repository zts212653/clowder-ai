import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import postcss from 'postcss';

// This is a complete opaque-origin document. Its typography belongs to the work,
// which cannot resolve the Host's --console-font-* properties.
const STANDALONE_DOCUMENT = 'components/onboarding-demo/demo-deliverable.ts';

// Letters drawn inside file-format icons scale with the icon, not the text hierarchy.
// Each exception is fenced by file, complete selector and literal value.
const ICON_LETTER_SIZES = [
  { file: 'components/chat-references/chat-reference.module.css', selector: '.officeIcon', value: '8.5px' },
  { file: 'components/chat-references/chat-reference.module.css', selector: '.pdfIcon', value: '5.5px' },
  { file: 'components/chat-references/chat-reference.module.css', selector: '.big .pdfIcon', value: '9px' },
  { file: 'components/chat-references/chat-reference.module.css', selector: '.grid .big .officeIcon', value: '9px' },
  { file: 'components/artifacts/work-cover.css', selector: '.work-cover-office', value: '8px' },
] as const;

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    if (entry === '__tests__') return [];
    const full = resolve(root, entry);
    return statSync(full).isDirectory() ? sourceFiles(full) : /\.(ts|tsx|css)$/.test(entry) ? [full] : [];
  });
}

function withoutIconLetterSizes(file: string, source: string): string {
  const allowed = ICON_LETTER_SIZES.filter((entry) => entry.file === file);
  if (allowed.length === 0) return source;
  const sheet = postcss.parse(source);
  sheet.walkDecls('font-size', (declaration) => {
    const rule = declaration.parent;
    if (
      rule?.type === 'rule' &&
      allowed.some((entry) => entry.selector === rule.selector && entry.value === declaration.value)
    )
      declaration.remove();
  });
  return sheet.toString();
}

export function typographyViolations(srcRoot: string): string[] {
  return sourceFiles(srcRoot)
    .filter((file) => !/[\\/]dev[\\/]/.test(file))
    .flatMap((file) => {
      const path = relative(srcRoot, file).replaceAll('\\', '/');
      if (path === STANDALONE_DOCUMENT) return [];
      const src = withoutIconLetterSizes(path, readFileSync(file, 'utf8'));
      const matches = [
        ...(src.match(/text-\[\d+(?:\.\d+)?px\]/g) ?? []),
        ...(src.match(/fontSize:\s*['"]?\d/g) ?? []),
        ...(src.match(/fontSize=\{\d/g) ?? []),
        ...(src.match(/font-size:\s*(?:\d|0\.)/g) ?? []),
      ];
      return matches.map((match) => `src/${path}: ${match}`);
    });
}
