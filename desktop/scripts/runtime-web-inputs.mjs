import fs from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';

export const packageSignature = (manifest) => JSON.stringify([manifest.name, manifest.version ?? null]);

function traceFiles(directory, next, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Linked Web trace input');
    if (entry.isDirectory()) {
      if (directory === next && ['cache', 'standalone'].includes(entry.name)) continue;
      traceFiles(file, next, output);
    } else if (entry.name.endsWith('.nft.json')) output.push(file);
  }
  return output;
}

function packageForFile(file) {
  const normalized = path.resolve(file).replaceAll('\\', '/');
  // Retain the outer package containing a private/embedded asset. In pnpm's
  // virtual store the first component is metadata, not a package boundary.
  for (const match of normalized.matchAll(/\/node_modules\/((?:@[^/]+\/)?[^/]+)/g)) {
    if (match[1].startsWith('.')) continue;
    const directory = normalized.slice(0, match.index + match[0].length);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (typeof manifest.name !== 'string') throw new Error('Unidentified traced package');
    return { name: manifest.name, signature: packageSignature(manifest) };
  }
  throw new Error('Unidentified traced package');
}

function readTrace(file) {
  const trace = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (trace.version !== 1 || !Array.isArray(trace.files)) throw new Error('Invalid Web dependency trace');
  return trace.files.flatMap((relative) => {
    if (typeof relative !== 'string') throw new Error('Invalid traced Web dependency');
    const source = path.resolve(path.dirname(file), relative);
    if (!fs.existsSync(source)) throw new Error('Missing traced Web dependency');
    return `/${relative.replaceAll('\\', '/')}`.includes('/node_modules/') ? [packageForFile(source)] : [];
  });
}

function callDependency(node, ts, tree) {
  if (!ts.isCallExpression(node)) return null;
  const expression = node.expression;
  const direct = ts.isIdentifier(expression) && expression.text === 'require';
  const resolve =
    ts.isPropertyAccessExpression(expression) &&
    expression.expression.getText(tree) === 'require' &&
    expression.name.text === 'resolve';
  const moduleRequire =
    ts.isPropertyAccessExpression(expression) &&
    expression.expression.getText(tree) === 'module' &&
    expression.name.text === 'require';
  if (!direct && !resolve && !moduleRequire && expression.kind !== ts.SyntaxKind.ImportKeyword) return null;
  const value = node.arguments[0];
  if (!value || !ts.isStringLiteral(value)) throw new Error('Untraceable Next configuration dependency');
  return value.text;
}

const directlyCalled = (node, ts) => ts.isCallExpression(node.parent) && node.parent.expression === node;

function allowedLoaderProperty(node, ts) {
  const property = node.parent;
  if (!ts.isPropertyAccessExpression(property) || property.expression !== node) return false;
  if (node.text === 'module' && property.name.text === 'exports') return true;
  return ['resolve', 'require'].includes(property.name.text) && directlyCalled(property, ts);
}

function checkLoaderReference(node, ts) {
  if (!ts.isIdentifier(node) || !['require', 'module'].includes(node.text)) return;
  const parent = node.parent;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return;
  if (node.text === 'require' && directlyCalled(node, ts)) return;
  if (allowedLoaderProperty(node, ts)) return;
  throw new Error('Untraceable Next configuration loader reference');
}

/** Parse project configuration/local helpers, never execute the configuration. */
function configPackages(web) {
  const ts = createRequire(import.meta.url)('typescript');
  const pending = ['next.config.js', 'next.config.mjs', 'next.config.cjs']
    .map((name) => path.join(web, name))
    .filter(fs.existsSync);
  const seen = new Set(),
    packages = new Set();
  const project = path.resolve(web, '../..');
  const add = (specifier, file) => {
    if (['module', 'node:module'].includes(specifier)) throw new Error('Untraceable Next configuration loader factory');
    if (isBuiltin(specifier)) return;
    if (!specifier.startsWith('.')) {
      packages.add(specifier.match(/^(@[^/]+\/[^/]+|[^/]+)/)[1]);
      return;
    }
    const dependency = fs.realpathSync(createRequire(file).resolve(specifier));
    if (!dependency.startsWith(project + path.sep)) throw new Error('External Next configuration helper');
    pending.push(dependency);
  };
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (/\.(json|node)$/.test(file)) continue;
    const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true);
    if (tree.parseDiagnostics.length) throw new Error('Invalid Next configuration source');
    const visit = (node) => {
      checkLoaderReference(node, ts);
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
        add(node.moduleSpecifier.text, file);
      const dependency = callDependency(node, ts, tree);
      if (dependency) add(dependency, file);
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  return [...packages].sort();
}

export function webProductionInputs(web, expectedCommit) {
  const next = path.resolve(web, '.next');
  const stamp = path.join(next, '.build-commit');
  if (
    !/^[a-f0-9]{40}$/.test(expectedCommit ?? '') ||
    !fs.existsSync(stamp) ||
    fs.readFileSync(stamp, 'utf8').trim() !== expectedCommit
  )
    throw new Error('Web build identity does not match dependency selection');
  if (!fs.existsSync(path.join(next, 'BUILD_ID'))) throw new Error('Missing Web build identity');
  if (!fs.existsSync(path.join(next, 'next-server.js.nft.json')))
    throw new Error('Missing Next production server trace');
  const files = traceFiles(next, next);
  const packages = new Map(files.flatMap(readTrace).map((record) => [record.signature, record]));
  return { traces: files.length, packages: [...packages.values()], configPackages: configPackages(path.resolve(web)) };
}
