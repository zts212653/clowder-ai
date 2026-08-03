import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const REQUIRED_ARCHITECTURE_ANCHORS = [
  'packages/shared/src/approval-producer-catalog.ts',
  'packages/api/src/domains/approval-hub/ApprovalIngress.ts',
  'packages/api/src/domains/approval-hub/ApprovalProducerRegistry.ts',
  'packages/api/src/domains/approval-hub/requireAnchoredPublication.ts',
  'packages/api/src/routes/approval-hub-routes.ts',
  'packages/web/src/lib/approval-features.ts',
  'packages/web/src/components/ApprovalProvenanceLinks.tsx',
];

function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

function reportDuplicates(violations, values, label) {
  for (const value of duplicates(values)) violations.push(`duplicate ${label}: ${value}`);
}

function reportMissing(violations, required, actual, label) {
  for (const value of required) {
    if (!actual.includes(value)) violations.push(`${label}: ${value}`);
  }
}

function parseProducerOrderIds(source) {
  const match = source.match(/APPROVAL_PRODUCER_IDS\s*=\s*Object\.freeze\(\s*\[([\s\S]*?)\]/);
  if (!match) return [];
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1]);
}

function parseCatalogEntryIds(source) {
  const match = source.match(/APPROVAL_PRODUCER_CATALOG\s*=\s*\{([\s\S]*?)\n\}\s+as const/);
  if (!match) return [];
  return [...match[1].matchAll(/^ {2}(?:['"]([^'"]+)['"]|([A-Za-z][\w-]*))\s*:/gm)].map(
    (entry) => entry[1] ?? entry[2],
  );
}

function parseApiBindingIds(source) {
  const match = source.match(/new\s+ApprovalProducerRegistry\s*\(\s*\{([\s\S]*?)\n\s*\}\s*\)/);
  if (!match) return [];
  return [...match[1].matchAll(/^ {4}(?:['"]([^'"]+)['"]|([A-Za-z][\w-]*))\s*:/gm)].map(
    (entry) => entry[1] ?? entry[2],
  );
}

export function validateApprovalProducerRegistrySources({
  catalogSource,
  apiCompositionSource,
  webRegistrySource,
  architectureSource,
}) {
  const violations = [];
  const catalogIds = parseCatalogEntryIds(catalogSource);
  const producerOrderIds = parseProducerOrderIds(catalogSource);
  const bindingIds = parseApiBindingIds(apiCompositionSource);

  if (catalogIds.length === 0) {
    violations.push('shared catalog does not declare APPROVAL_PRODUCER_CATALOG entries');
  }
  if (producerOrderIds.length === 0) {
    violations.push('shared catalog does not declare APPROVAL_PRODUCER_IDS');
  }

  reportDuplicates(violations, catalogIds, 'catalog entry');
  reportDuplicates(violations, producerOrderIds, 'producer order ID');
  reportDuplicates(violations, bindingIds, 'API binding');
  reportMissing(violations, catalogIds, producerOrderIds, 'missing producer order ID');
  reportMissing(violations, producerOrderIds, catalogIds, 'missing catalog entry');
  reportMissing(violations, producerOrderIds, bindingIds, 'missing API binding');
  reportMissing(violations, bindingIds, producerOrderIds, 'extra API binding');

  const derivesFromSharedCatalog =
    webRegistrySource.includes('APPROVAL_PRODUCER_CATALOG') &&
    webRegistrySource.includes('APPROVAL_PRODUCER_IDS') &&
    webRegistrySource.includes("from '@cat-cafe/shared'");
  if (!derivesFromSharedCatalog) {
    violations.push('Web registry must derive from the shared catalog and producer IDs');
  }
  if (!derivesFromSharedCatalog && /\b(label|badgeLabel|colorToken|decisionEndpointBase)\s*:/.test(webRegistrySource)) {
    violations.push('Web registry contains handwritten metadata');
  }

  for (const anchor of REQUIRED_ARCHITECTURE_ANCHORS) {
    if (!architectureSource.includes(anchor)) violations.push(`missing architecture anchor: ${anchor}`);
  }

  return violations;
}

async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const [catalogSource, apiCompositionSource, webRegistrySource, architectureSource] = await Promise.all([
    readFile(`${root}/packages/shared/src/approval-producer-catalog.ts`, 'utf8'),
    readFile(`${root}/packages/api/src/index.ts`, 'utf8'),
    readFile(`${root}/packages/web/src/lib/approval-features.ts`, 'utf8'),
    readFile(`${root}/docs/architecture/ownership/cells/approval-index.md`, 'utf8'),
  ]);
  const violations = validateApprovalProducerRegistrySources({
    catalogSource,
    apiCompositionSource,
    webRegistrySource,
    architectureSource,
  });
  if (violations.length > 0) {
    console.error('Approval producer registry parity check FAILED:');
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log('Approval producer registry parity check PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
