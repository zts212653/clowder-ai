import { basename, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkShellCopyParity, listShellCopyFiles, loadShellCopies } from './shell-copy-parity-check';

const SRC = join(__dirname, '..', '..', '..');
const SHELL = join(__dirname, '..');
const FIXTURES = join(__dirname, 'fixtures');

describe('the dictionary is the *.shell-copy.ts files beside their pages — no registry to edit', () => {
  it('lists them across the source tree, sorted, and leaves test folders out unless asked', () => {
    const real = listShellCopyFiles(SRC);
    expect(real).toEqual([...real].sort());
    expect(real.every((file) => file.endsWith('.shell-copy.ts') && !file.includes('__tests__'))).toBe(true);

    // The shell folder holds this very test folder with the fixtures in it: skipped by default, found when asked for.
    expect(listShellCopyFiles(SHELL).some((file) => file.includes('__tests__'))).toBe(false);
    const withTests = listShellCopyFiles(SHELL, { includeTests: true }).map((file) => relative(FIXTURES, file));
    expect(withTests).toEqual(
      expect.arrayContaining([
        join('shell-copy-ok', 'alpha.shell-copy.ts'),
        join('shell-copy-ok', 'beta.shell-copy.ts'),
        join('shell-copy-stray', 'stray.shell-copy.ts'),
      ]),
    );
  });

  it('finds the namespaces a file defines and checks each one (shown on fixtures that stand in for two surfaces)', async () => {
    const found = [];
    for (const file of listShellCopyFiles(join(FIXTURES, 'shell-copy-ok'), { includeTests: true })) {
      found.push(...(await loadShellCopies(file)));
    }
    expect(found.map((entry) => entry.name)).toEqual(['alphaCopy', 'betaCopy']);
    for (const { name, copy } of found) expect(checkShellCopyParity(copy), name).toEqual([]);
  });

  it('sees that a *.shell-copy.ts file which defines no namespace has none to check', async () => {
    const [stray] = listShellCopyFiles(join(FIXTURES, 'shell-copy-stray'), { includeTests: true });
    expect(await loadShellCopies(stray)).toEqual([]);
  });

  it('every *.shell-copy.ts in the app defines at least one namespace, and every namespace is consistent in both languages', async () => {
    for (const file of listShellCopyFiles(SRC)) {
      const copies = await loadShellCopies(file);
      expect(copies.length, `${basename(file)} exports no defineShellCopy(...)`).toBeGreaterThan(0);
      for (const { name, copy } of copies) {
        expect(checkShellCopyParity(copy), `${relative(SRC, file)} › ${name}`).toEqual([]);
      }
    }
  });
});
