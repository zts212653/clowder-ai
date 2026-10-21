import fs from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withFrozenDependencyResolution } from './frozen-dependency-resolution.mjs';

const tools = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Use the compiler already pinned by the API's tsx build dependency. Resolve
// from that package boundary so strict pnpm linking is reproducible.
const apiTools = createRequire(path.join(projectRoot, 'packages/api/package.json'));
const { build } = createRequire(apiTools.resolve('tsx/package.json'))('esbuild');
const ts = apiTools('typescript');

// Keep native addons, workspace/class identities, telemetry globals and packages
// with dynamic assets in the frozen dependency tree. Only audited JS modules
// enter this bundle; this is not permission to prune the runtime dependency graph.
const bundledDependencies = new Set([
  'yaml',
  'smol-toml',
  'fast-xml-parser',
  '@opentelemetry/core',
  '@opentelemetry/configuration',
  '@opentelemetry/resources',
  '@opentelemetry/sdk-logs',
  '@opentelemetry/sdk-metrics',
  '@opentelemetry/sdk-node',
  '@opentelemetry/sdk-trace-base',
  '@opentelemetry/sdk-trace-node',
  '@opentelemetry/context-async-hooks',
  '@opentelemetry/exporter-logs-otlp-http',
  '@opentelemetry/exporter-logs-otlp-grpc',
  '@opentelemetry/exporter-logs-otlp-proto',
  '@opentelemetry/exporter-metrics-otlp-http',
  '@opentelemetry/exporter-metrics-otlp-grpc',
  '@opentelemetry/exporter-metrics-otlp-proto',
  '@opentelemetry/exporter-prometheus',
  '@opentelemetry/exporter-trace-otlp-http',
  '@opentelemetry/exporter-trace-otlp-grpc',
  '@opentelemetry/exporter-trace-otlp-proto',
  '@opentelemetry/exporter-zipkin',
  '@opentelemetry/otlp-exporter-base',
  '@opentelemetry/otlp-grpc-exporter-base',
  '@opentelemetry/otlp-transformer',
  '@opentelemetry/propagator-b3',
  '@opentelemetry/propagator-jaeger',
  '@opentelemetry/semantic-conventions',
]);
const packageName = (name) => name.match(/^(@[^/]+\/[^/]+|[^/]+)/)?.[1];

async function verifyExternalIdentity(builder, args, entry, dist) {
  const resolve = (importer, resolveDir) =>
    builder.resolve(args.path, {
      importer,
      resolveDir,
      kind: args.kind,
      pluginData: { externalIdentityProbe: true },
    });
  const [original, emitted] = await Promise.all([resolve(args.importer, args.resolveDir), resolve(entry, dist)]);
  const identity = (result) => (result.errors.length ? null : fs.realpathSync(result.path));
  if (identity(original) !== identity(emitted))
    throw new Error(`Desktop bundle would change external dependency identity: ${args.path}`);
}

function preserveModuleUrl(code, file, dist) {
  if (!code.includes('import.meta')) return code;
  const tree = ts.createSourceFile(file, code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const ranges = [];
  const visit = (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'url' &&
      ts.isMetaProperty(node.expression) &&
      node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    )
      ranges.push([node.getStart(tree), node.end]);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  if (!ranges.length) return code;
  const relative = './' + path.relative(dist, file).replaceAll('\\', '/');
  const replacement = `new URL(${JSON.stringify(relative)}, import.meta.url).href`;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0]))
    code = code.slice(0, start) + replacement + code.slice(end);
  return code;
}

async function bundleEntrypoint(apiRoot, relativeEntry, relativeOutput, dependencies) {
  const dist = fs.realpathSync(path.resolve(apiRoot, 'dist'));
  const entry = path.join(dist, relativeEntry);
  const output = path.join(dist, relativeOutput);
  const outputDirectory = path.dirname(output);
  const includedDependencies = new Set();
  const result = await build({
    entryPoints: [entry],
    outfile: output,
    bundle: true,
    nodePaths: [path.resolve(apiRoot, '../dependencies')],
    platform: 'node',
    target: 'node24',
    format: 'esm',
    banner: {
      js: "import { createRequire as __desktopCreateRequire } from 'node:module'; const require = __desktopCreateRequire(import.meta.url);",
    },
    sourcemap: 'linked',
    metafile: true,
    logLevel: 'silent',
    plugins: [
      {
        name: 'original-module-urls',
        setup(builder) {
          builder.onResolve({ filter: /^[^./\\]/ }, async (args) => {
            if (args.pluginData?.externalIdentityProbe) return;
            if (path.isAbsolute(args.path)) return;
            const name = packageName(args.path);
            if (dependencies.has(name)) {
              includedDependencies.add(name);
              return;
            }
            if (args.importer && !args.importer.startsWith(dist + path.sep) && !isBuiltin(args.path)) {
              await verifyExternalIdentity(builder, args, output, outputDirectory);
            }
            return { path: args.path, external: true };
          });
          builder.onLoad({ filter: /\.[cm]?js$/ }, (args) => {
            const code = fs.readFileSync(args.path, 'utf8');
            if (args.path.startsWith(dist + path.sep))
              return { contents: preserveModuleUrl(code, args.path, outputDirectory), loader: 'js' };
            // Fail closed when a dependency upgrade adds location-dependent behavior.
            if (/\b(?:__dirname|__filename)\b|import\.meta|require\.resolve\s*\(/.test(code))
              throw new Error(`Desktop dependency needs an external asset boundary: ${args.path}`);
            return { contents: code, loader: 'js' };
          });
        },
      },
    ],
  });
  return {
    entry: `dist/${relativeOutput.replaceAll('\\', '/')}`,
    original: `dist/${relativeEntry.replaceAll('\\', '/')}`,
    modules: Object.keys(result.metafile.inputs).length,
    bytes: fs.statSync(output).size,
    originalModuleUrlsPreserved: true,
    dependenciesBundled: includedDependencies.size > 0,
    bundledPackages: [...includedDependencies].sort(),
  };
}

/** This independent installer process never shares its registry with the API. */
export function bundleDesktopAgentHooks(apiRoot) {
  return bundleEntrypoint(
    apiRoot,
    'agent-hooks/index.js',
    'agent-hooks/index.desktop.js',
    new Set(['@cat-cafe/shared', 'smol-toml', 'yaml']),
  );
}

/** Keep the original dist tree for workers, dynamic paths and unbundled tooling. */
export async function bundleDesktopApi(apiRoot) {
  return withFrozenDependencyResolution(path.dirname(fs.realpathSync(apiRoot)), () => bundleApi(apiRoot));
}

async function bundleApi(apiRoot) {
  const receipt = await bundleEntrypoint(apiRoot, 'index.js', 'index.desktop.js', bundledDependencies);
  if (fs.existsSync(path.join(apiRoot, 'dist/agent-hooks/index.js')))
    receipt.agentHooks = await bundleDesktopAgentHooks(apiRoot);
  fs.writeFileSync(path.join(apiRoot, 'dist/desktop-bundle.json'), JSON.stringify(receipt));
  return receipt;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  console.log(JSON.stringify(await bundleDesktopApi(path.resolve(process.argv[2]))));
