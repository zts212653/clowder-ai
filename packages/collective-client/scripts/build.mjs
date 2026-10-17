import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest('hex');

/** Same recipe for the client package and the Host's retained-asset distribution. */
export async function buildRetainedClient(outdir = path.join(root, 'dist')) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['src/main.tsx'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    jsx: 'automatic',
    outfile: path.join(outdir, 'collective-client/app.js'),
    alias: { '@cat-cafe/shared': path.resolve(root, '../shared/src/index.ts') },
    sourcemap: false,
    minify: false,
    legalComments: 'none',
    external: ['/collective-client/collective-landing-A.png'],
    write: false,
    metafile: true,
  });
  const files = [];
  for (const file of result.outputFiles) {
    const name = path.relative(outdir, file.path).split(path.sep).join('/');
    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, file.contents);
    files.push({
      path: '/' + name,
      size: file.contents.length,
      sha256: hash(file.contents),
      contentType: name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
    });
  }
  const landing = await readFile(path.join(root, 'assets/collective-landing-A.png'));
  await writeFile(path.join(outdir, 'collective-client/collective-landing-A.png'), landing);
  files.push({
    path: '/collective-client/collective-landing-A.png',
    size: landing.length,
    sha256: hash(landing),
    contentType: 'image/png',
  });
  const html = await readFile(path.join(root, 'src/index.html'));
  await writeFile(path.join(outdir, 'index.html'), html);
  files.push({ path: '/index.html', size: html.length, sha256: hash(html), contentType: 'text/html; charset=utf-8' });
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const clientBuildId = 'collective-client-v2';
  const assetDigest = hash(JSON.stringify(files.map(({ path, size, sha256 }) => ({ path, size, sha256 }))));
  await writeFile(
    path.join(outdir, 'manifest.json'),
    JSON.stringify({ version: 1, clientBuildId, files }, null, 2) + '\n',
  );
  const inputs = await Promise.all(
    [...Object.keys(result.metafile.inputs), 'src/index.html', 'scripts/build.mjs', 'assets/collective-landing-A.png']
      .sort()
      .map(async (name) => ({ path: name, sha256: hash(await readFile(path.resolve(root, name))) })),
  );
  await writeFile(
    path.join(outdir, 'build-inputs.json'),
    JSON.stringify({ version: 1, sourceAlias: '@cat-cafe/shared -> packages/shared/src/index.ts', inputs }, null, 2) +
      '\n',
  );
  return { clientBuildId, assetDigest };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildRetainedClient();
