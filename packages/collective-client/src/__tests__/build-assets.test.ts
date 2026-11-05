import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('builds the retained client assets without private docs', async () => {
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'collective-client-build-'));
  const fixturePackage = join(fixtureRoot, 'packages', 'collective-client');
  try {
    await cp(packageRoot, fixturePackage, {
      recursive: true,
      filter: (source) => !['node_modules', 'dist'].includes(basename(source)),
    });
    await cp(join(packageRoot, '../../tsconfig.base.json'), join(fixtureRoot, 'tsconfig.base.json'));
    await cp(join(packageRoot, '../shared'), join(fixtureRoot, 'packages/shared'), {
      recursive: true,
      filter: (source) => !['node_modules', 'dist'].includes(basename(source)),
    });
    await symlink(
      join(packageRoot, '../shared/node_modules'),
      join(fixtureRoot, 'packages/shared/node_modules'),
      'dir',
    );
    const sharedStyles = join(fixtureRoot, 'packages/web/src/app');
    await mkdir(sharedStyles, { recursive: true });
    for (const filename of ['theme-tokens.css', 'console-tokens.css']) {
      await cp(join(packageRoot, '../web/src/app', filename), join(sharedStyles, filename));
    }
    await symlink(join(packageRoot, '../../node_modules'), join(fixtureRoot, 'node_modules'), 'dir');
    await symlink(join(packageRoot, 'node_modules'), join(fixturePackage, 'node_modules'), 'dir');

    execFileSync('pnpm', ['run', 'build'], { cwd: fixturePackage, stdio: 'inherit', timeout: 60_000 });

    const dist = join(fixturePackage, 'dist');
    expect(await readFile(join(dist, 'index.html'), 'utf8')).toContain('/collective-client/app.js');
    const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
    expect(manifest.files.map((file: { path: string }) => file.path).sort()).toEqual([
      '/collective-client/app.css',
      '/collective-client/app.js',
      '/collective-client/collective-landing-A.png',
      '/index.html',
    ]);
    for (const file of manifest.files) {
      const bytes = await readFile(join(dist, file.path));
      expect(bytes.length).toBeGreaterThan(0);
      expect(bytes.length).toBe(file.size);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
    }
    expect(await readFile(join(dist, 'collective-client/collective-landing-A.png'))).toEqual(
      await readFile(join(fixturePackage, 'assets/collective-landing-A.png')),
    );
    expect(await readFile(join(dist, 'collective-client/app.css'), 'utf8')).toContain(
      '/collective-client/collective-landing-A.png',
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}, 90_000);
