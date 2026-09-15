import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { isFunctionLike, lineOf, parseSource, propertyLiteral, walk } from './ast-utils.mjs';
import { canonicalJourneyTestPath, DEFAULT_ENTRY_JOURNEY_HARNESS } from './claim-journey-paths.mjs';
import { resolveImportTarget } from './mount-chain.mjs';
import { escapeRegExp, insideRepo, isRecord, nonEmptyString } from './shared.mjs';

// Every productIntegration claim binds one default-entry browser journey. This
// module checks the binding's *shape*; the journey itself runs in the full gate
// (packages/web `test:browser`) and is the only reachability evidence.

const BROWSER_TEST_DIRECTORY = 'packages/web/test/browser/';
const WEB_MANIFEST = 'packages/web/package.json';
const PRODUCT_SOURCE_ROOTS = ['packages/web/src', 'packages/collective-client/src'];
const REGISTRATION = 'registerDefaultEntryJourney';
const JOURNEY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
// Playwright calls that let a test fabricate DOM, scripts or navigation instead of
// walking the product from its default entry.
const INJECTION_CALLS = new Set([
  'setContent',
  'goto',
  'addScriptTag',
  'addStyleTag',
  'evaluate',
  'evaluateHandle',
  '$eval',
  '$$eval',
  'exposeFunction',
  'exposeBinding',
]);
// addInitScript may only reset browser storage before the entry loads.
const STORAGE_IDENTIFIERS = new Set([
  'window',
  'localStorage',
  'sessionStorage',
  'clear',
  'removeItem',
  'setItem',
  'getItem',
  'key',
  'length',
]);
const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/u;

export function browserRunnerTestPaths(script) {
  if (typeof script !== 'string') return [];
  return script
    .split(/\s+/u)
    .filter((token) => token.endsWith('.test.mjs'))
    .map((token) => token.replace(/^\.\.\/web\//u, ''))
    .filter((token) => token.startsWith('test/browser/'))
    .map((token) => `packages/web/${token}`);
}

function journeyShapeErrors(repoRoot, journey) {
  if (!isRecord(journey)) {
    return ['productIntegration.defaultEntryJourney must be an object with testPath, journeyId and surfaceTestId'];
  }
  const errors = [];
  if (!nonEmptyString(journey.testPath)) errors.push('defaultEntryJourney.testPath is required');
  else {
    const canonicalPath = canonicalJourneyTestPath(repoRoot, journey.testPath);
    if (!canonicalPath?.startsWith(BROWSER_TEST_DIRECTORY)) {
      errors.push(`defaultEntryJourney.testPath must live under ${BROWSER_TEST_DIRECTORY}: ${journey.testPath}`);
    } else if (journey.testPath !== canonicalPath) {
      errors.push(`defaultEntryJourney.testPath must use canonical repository path ${canonicalPath}`);
    }
  }
  if (!nonEmptyString(journey.journeyId) || !JOURNEY_ID.test(journey.journeyId)) {
    errors.push('defaultEntryJourney.journeyId must be a kebab-case identifier');
  }
  if (!nonEmptyString(journey.surfaceTestId)) errors.push('defaultEntryJourney.surfaceTestId is required');
  return errors;
}

function validateRunner({ repoRoot, testPath, errors }) {
  const manifestPath = insideRepo(repoRoot, WEB_MANIFEST);
  if (!manifestPath || !existsSync(manifestPath)) {
    errors.push(`defaultEntryJourney: canonical browser runner manifest is missing: ${WEB_MANIFEST}`);
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    errors.push(`defaultEntryJourney: ${WEB_MANIFEST} is not valid JSON: ${error.message}`);
    return;
  }
  if (!browserRunnerTestPaths(manifest.scripts?.['test:browser']).includes(testPath)) {
    errors.push(`defaultEntryJourney: ${testPath} is not run by ${WEB_MANIFEST}#scripts.test:browser`);
  }
}

function harnessImportBinding({ repoRoot, testPath, sourceFile }) {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target = resolveImportTarget({ repoRoot, parentPath: testPath, specifier: statement.moduleSpecifier.text });
    if (!target || relative(repoRoot, target).split(sep).join('/') !== DEFAULT_ENTRY_JOURNEY_HARNESS) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const element = bindings.elements.find((entry) => (entry.propertyName ?? entry.name).text === REGISTRATION);
    if (element) return { name: element.name.text, node: element };
  }
  return undefined;
}

function declaresName(node, name) {
  const declares =
    ts.isFunctionDeclaration(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isParameter(node) ||
    ts.isBindingElement(node) ||
    ts.isImportSpecifier(node) ||
    ts.isClassDeclaration(node);
  return declares && Boolean(node.name) && ts.isIdentifier(node.name) && node.name.text === name;
}

function shadowLines(sourceFile, binding) {
  const lines = [];
  walk(sourceFile, (node) => {
    if (node !== binding.node && declaresName(node, binding.name)) lines.push(lineOf(node));
  });
  return lines;
}

function collectRegistrations(sourceFile, bindingName) {
  const registrations = [];
  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== bindingName) return;
    const [options, body] = node.arguments;
    registrations.push({
      node,
      journeyId: propertyLiteral(options, 'journeyId'),
      surfaceTestId: propertyLiteral(options, 'surfaceTestId'),
      body,
    });
  });
  return registrations;
}

function nonStorageUse(script) {
  if (!script || !isFunctionLike(script)) return ['a non-inline script'];
  const outside = new Set();
  walk(script.body, (node) => {
    if (ts.isIdentifier(node) && !STORAGE_IDENTIFIERS.has(node.text)) outside.add(node.text);
    if (ts.isElementAccessExpression(node)) outside.add('computed member access');
  });
  return [...outside];
}

function bodyViolations(body) {
  const violations = [];
  walk(body, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const name = node.expression.name.text;
    if (INJECTION_CALLS.has(name)) violations.push(`${name}() at line ${lineOf(node)}`);
    if (name === 'addInitScript') {
      const outside = nonStorageUse(node.arguments[0]);
      if (outside.length > 0) {
        violations.push(
          `addInitScript() at line ${lineOf(node)} touches ${outside.join(', ')} (only browser storage resets are allowed)`,
        );
      }
    }
  });
  return violations;
}

function validateRegistration({ repoRoot, testPath, testAbsolutePath, journeyId, surfaceTestId, errors }) {
  const sourceFile = parseSource(testAbsolutePath);
  const binding = harnessImportBinding({ repoRoot, testPath, sourceFile });
  if (!binding) {
    errors.push(`defaultEntryJourney: ${testPath} must import ${REGISTRATION} from ${DEFAULT_ENTRY_JOURNEY_HARNESS}`);
    return;
  }
  const shadows = shadowLines(sourceFile, binding);
  if (shadows.length > 0) {
    errors.push(
      `defaultEntryJourney: ${REGISTRATION} binding is shadowed in ${testPath} at line ${shadows.join(', ')}`,
    );
    return;
  }
  const matches = collectRegistrations(sourceFile, binding.name).filter((entry) => entry.journeyId === journeyId);
  if (matches.length !== 1) {
    errors.push(
      `defaultEntryJourney: journeyId ${journeyId} must be registered exactly once in ${testPath} (found ${matches.length})`,
    );
    return;
  }
  const [registration] = matches;
  if (registration.surfaceTestId !== surfaceTestId) {
    errors.push(
      `defaultEntryJourney: registration ${journeyId} asserts surfaceTestId ${registration.surfaceTestId ?? '<missing>'}, claim says ${surfaceTestId}`,
    );
  }
  if (!registration.body || !isFunctionLike(registration.body)) {
    errors.push(`defaultEntryJourney: registration ${journeyId} needs an inline journey body`);
    return;
  }
  for (const violation of bodyViolations(registration.body)) {
    errors.push(
      `defaultEntryJourney: journey ${journeyId} injects DOM or navigation instead of walking the product: ${violation}`,
    );
  }
}

function testIdCount(source, testId) {
  const id = escapeRegExp(testId);
  const pattern = new RegExp(`data-testid=(?:"${id}"|'${id}'|\\{\\s*["'\`]${id}["'\`]\\s*\\})`, 'gu');
  return (source.match(pattern) ?? []).length;
}

function productSourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '__tests__') files.push(...productSourceFiles(entryPath));
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.test(entry.name) && !/\.(?:test|spec|stories)\./u.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

function validateSurfaceTestId({ repoRoot, finalSurface, surfaceTestId, errors }) {
  const surfacePath = insideRepo(repoRoot, finalSurface?.path);
  if (!surfacePath || !existsSync(surfacePath)) return; // mount-chain validation reports the missing file
  const sourceRoot = PRODUCT_SOURCE_ROOTS.find((root) => finalSurface.path.startsWith(`${root}/`));
  if (!sourceRoot) {
    errors.push(
      `defaultEntryJourney: final surface must be product source under ${PRODUCT_SOURCE_ROOTS.join(' or ')}: ${finalSurface.path}`,
    );
    return;
  }
  const count = testIdCount(readFileSync(surfacePath, 'utf8'), surfaceTestId);
  if (count !== 1) {
    errors.push(
      `defaultEntryJourney: surfaceTestId ${surfaceTestId} must appear exactly once as data-testid in ${finalSurface.path} (found ${count})`,
    );
  }
  const others = PRODUCT_SOURCE_ROOTS.filter((root) => existsSync(resolve(repoRoot, root)))
    .flatMap((root) => productSourceFiles(resolve(repoRoot, root)))
    .filter((file) => file !== surfacePath && testIdCount(readFileSync(file, 'utf8'), surfaceTestId) > 0)
    .map((file) => relative(repoRoot, file).split(sep).join('/'));
  if (others.length > 0) {
    errors.push(
      `defaultEntryJourney: surfaceTestId ${surfaceTestId} is not unique to the final surface; also in ${others.join(', ')}`,
    );
  }
}

export function validateDefaultEntryJourney({ repoRoot, journey, finalSurface, errors }) {
  if (journey === undefined) {
    errors.push(
      'productIntegration.defaultEntryJourney is required: every product-integration claim binds one default-entry browser journey (testPath, journeyId, surfaceTestId)',
    );
    return;
  }
  const shapeErrors = journeyShapeErrors(repoRoot, journey);
  if (shapeErrors.length > 0) {
    errors.push(...shapeErrors);
    return;
  }
  const { testPath, journeyId, surfaceTestId } = journey;
  const testAbsolutePath = insideRepo(repoRoot, testPath);
  if (!testAbsolutePath || !existsSync(testAbsolutePath)) {
    errors.push(`defaultEntryJourney.testPath does not exist: ${testPath}`);
    return;
  }
  validateRunner({ repoRoot, testPath, errors });
  validateRegistration({ repoRoot, testPath, testAbsolutePath, journeyId, surfaceTestId, errors });
  validateSurfaceTestId({ repoRoot, finalSurface, surfaceTestId, errors });
}
