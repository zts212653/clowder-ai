import fs from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withFrozenDependencyResolution } from './frozen-dependency-resolution.mjs';
import { fileHash, inside, runtimePackageExports, runtimePackageRoots } from './runtime-package-bundle-graph.mjs';
import { runtimePackageInput } from './runtime-package-bundle-inputs.mjs';

const tools = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// tsx/esbuild are owned by the API workspace. Resolve them from that explicit
// package boundary instead of relying on a hoisted root node_modules layout.
const apiTools = createRequire(path.join(projectRoot, 'packages/api/package.json'));
const { build } = createRequire(apiTools.resolve('tsx/package.json'))('esbuild');
const relative = (root, file) => path.relative(root, file).replaceAll('\\', '/');

async function validateRequiredModule(resolve, specifier, canonical, packageRoot, snapshots) {
  if (isBuiltin(specifier)) return;
  const target = await resolve(specifier, path.dirname(canonical), 'require-call');
  if (!inside(packageRoot, target) || path.relative(packageRoot, target).split(path.sep).includes('node_modules'))
    return;
  if (!target.endsWith('.json')) throw new Error('Unsupported runtime package internal JavaScript require');
  snapshots.set(target, fileHash(target));
}

/** Read-only planning is also used to audit real frozen package versions. */
export async function planRuntimePackage(root, packageRoot) {
  const { manifest, manifestFile, entries, assets } = runtimePackageExports(packageRoot);
  const dist = path.join(packageRoot, 'dist'),
    outdir = path.join(dist, '.desktop-bundle');
  if (fs.existsSync(outdir) || entries.some((entry) => fs.existsSync(`${entry.file}.desktop-original`)))
    throw new Error('Runtime package bundling requires fresh frozen output');
  const snapshots = new Map([manifestFile, ...assets].map((file) => [file, fileHash(file)]));
  const remember = (file) => {
    const canonical = fs.realpathSync(file);
    if (!inside(dist, canonical) || path.relative(dist, canonical).split(path.sep).includes('node_modules'))
      throw new Error('Input is outside its package dist identity');
    snapshots.set(file, fileHash(file));
    return canonical;
  };
  const result = await build({
    entryPoints: Object.fromEntries(entries.map((entry, index) => [`entry-${index}`, entry.file])),
    outdir,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    entryNames: '[name]',
    chunkNames: 'chunk-[hash]',
    metafile: true,
    write: false,
    logLevel: 'silent',
    nodePaths: [path.join(root, 'dependencies')],
    plugins: [
      {
        name: 'canonical-package-boundaries',
        setup(builder) {
          const resolve = async (specifier, resolveDir, kind) => {
            const result = await builder.resolve(specifier, { resolveDir, kind, pluginData: { identityProbe: true } });
            if (result.errors.length || result.external || !result.path)
              throw new Error(`Unresolved frozen external dependency: ${specifier}`);
            const canonical = fs.realpathSync(result.path);
            if (!inside(root, canonical))
              throw new Error(`External dependency is outside the frozen output: ${specifier} -> ${canonical}`);
            return canonical;
          };
          builder.onResolve({ filter: /^[^./\\]/ }, async (args) => {
            if (args.pluginData?.identityProbe || path.isAbsolute(args.path)) return;
            if (isBuiltin(args.path)) return { path: args.path, external: true };
            const original = await resolve(args.path, args.resolveDir, args.kind);
            if ((args.path === manifest.name || args.path.startsWith(`${manifest.name}/`)) && inside(dist, original))
              return { path: original };
            if (original !== (await resolve(args.path, dist, args.kind)))
              throw new Error(`Runtime package would change external dependency identity: ${args.path}`);
            return { path: args.path, external: true };
          });
          builder.onLoad({ filter: /.*/ }, async (args) => {
            const canonical = remember(args.path);
            if (!canonical.endsWith('.js')) throw new Error('Unsupported runtime package module format');
            const { code, requires } = runtimePackageInput(fs.readFileSync(canonical, 'utf8'), canonical, outdir);
            // createRequire remains based at each preserved original module URL.
            for (const specifier of requires)
              await validateRequiredModule(resolve, specifier, canonical, packageRoot, snapshots);
            return { contents: code, loader: 'js' };
          });
        },
      },
    ],
  });
  return { packageRoot, manifest, entries, snapshots, result, outdir };
}

function atomicReplace(file, content) {
  const temporary = `${file}.desktop-tmp`;
  fs.writeFileSync(temporary, content, { flag: 'wx' });
  try {
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function emitEntry(entry, index, result, outdir) {
  const output = path.join(outdir, `entry-${index}.js`);
  const metadata = Object.entries(result.metafile.outputs).find(([file]) => path.resolve(file) === output)?.[1];
  if (!metadata) throw new Error('Runtime package entry is missing');
  const specifier = `./${relative(path.dirname(entry.file), output)}`;
  fs.writeFileSync(`${entry.file}.desktop-original`, fs.readFileSync(entry.file), { flag: 'wx' });
  atomicReplace(
    entry.file,
    `export * from ${JSON.stringify(specifier)};\n` +
      (metadata.exports.includes('default') ? `export {default} from ${JSON.stringify(specifier)};\n` : ''),
  );
}

function emitPackage(root, { packageRoot, manifest, entries, snapshots, result, outdir }) {
  fs.mkdirSync(outdir);
  for (const output of result.outputFiles) {
    if (path.dirname(output.path) !== outdir) throw new Error('Runtime package output must remain flat');
    fs.writeFileSync(output.path, output.contents, { flag: 'wx' });
  }
  for (const [index, entry] of entries.entries()) emitEntry(entry, index, result, outdir);
  return {
    name: manifest.name,
    version: manifest.version,
    canonicalRoot: relative(root, packageRoot),
    publicEntries: entries.length,
    bundledModules: Object.keys(result.metafile.inputs).length,
    generatedFiles: result.outputFiles.length,
    generatedBytes: result.outputFiles.reduce((sum, file) => sum + file.contents.byteLength, 0),
    originalAssetsRetained: true,
    originalEntryBackups: true,
    inputHashes: Object.fromEntries([...snapshots].map(([file, hash]) => [relative(packageRoot, file), hash])),
    outputHashes: Object.fromEntries(
      result.outputFiles.map((file) => [relative(packageRoot, file.path), fileHash(file.path)]),
    ),
    wrapperHashes: Object.fromEntries(
      entries.map((entry) => [relative(packageRoot, entry.file), fileHash(entry.file)]),
    ),
  };
}

/** Bundle real roots independently. Never reparent peers or mutate a source/cache inode. */
export async function bundleRuntimePackages(directory) {
  const root = fs.realpathSync(directory);
  return withFrozenDependencyResolution(root, () => bundlePackages(root));
}

async function bundlePackages(root) {
  const plans = [];
  for (const packageRoot of runtimePackageRoots(root)) plans.push(await planRuntimePackage(root, packageRoot));
  // Validate the entire graph before changing any public entry.
  for (const plan of plans)
    for (const [file, hash] of plan.snapshots)
      if (fileHash(file) !== hash) throw new Error('Frozen package input changed during bundling');
  return { packages: plans.map((plan) => emitPackage(root, plan)) };
}
