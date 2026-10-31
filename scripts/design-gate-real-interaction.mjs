import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateDefaultEntryJourney } from './design-gate/journey-evidence.mjs';
import { importedAndMounted } from './design-gate/mount-chain.mjs';
import { asStringList, escapeRegExp, insideRepo, isRecord, nonEmptyString } from './design-gate/shared.mjs';

const REQUIRED_EDITOR_CONTRACTS = ['human_edit', 'selection_anchor', 'annotation', 'patch_review', 'version_undo'];

function parseFeatureDocFrontmatter({ featureSource, featureDocPath, errors }) {
  const match = featureSource.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) {
    errors.push(`source.featureDocPath must contain YAML frontmatter: ${featureDocPath}`);
    return undefined;
  }
  try {
    const frontmatter = parseYaml(match[1]);
    if (!isRecord(frontmatter)) {
      errors.push(`source.featureDocPath frontmatter must be an object: ${featureDocPath}`);
      return undefined;
    }
    return frontmatter;
  } catch (error) {
    errors.push(`source.featureDocPath frontmatter is invalid YAML: ${featureDocPath}: ${error.message}`);
    return undefined;
  }
}

function validateMountNode({ repoRoot, node, label, errors }) {
  if (!nonEmptyString(node?.path) || !nonEmptyString(node?.export)) {
    errors.push(`every ${label} node needs path and export`);
    return;
  }
  if (/(?:^|\/)app\/dev(?:\/|$)/u.test(node.path) || /(?:^|\/)dev(?:\/|$)/u.test(node.path)) {
    errors.push(`${label} cannot use a dev route: ${node.path}`);
  }
  const absolutePath = insideRepo(repoRoot, node.path);
  if (!absolutePath || !existsSync(absolutePath)) {
    errors.push(`${label} path does not exist: ${node.path}`);
  }
}

// Structural disclosure only: each hop imports and mounts the next. Reachability
// from the default entry is proven by the bound browser journey, never here.
function validateMountChain({ repoRoot, mountChain, label, errors }) {
  for (const node of mountChain) validateMountNode({ repoRoot, node, label, errors });
  for (let index = 0; index < mountChain.length - 1; index += 1) {
    importedAndMounted({
      repoRoot,
      parent: mountChain[index],
      child: mountChain[index + 1],
      errors,
      label: `${label}[${index}]`,
    });
  }
}

function validateProductIntegration({ repoRoot, claim, errors }) {
  if (!isRecord(claim)) {
    errors.push('productIntegration claim must be an object');
    return;
  }
  if (!nonEmptyString(claim.userEntry)) errors.push('productIntegration.userEntry is required');
  if (/\/dev(?:\/|$)/u.test(claim.userEntry ?? '')) {
    errors.push('productIntegration.userEntry cannot be a /dev route');
  }
  if (Object.hasOwn(claim, 'queryNavigation')) {
    errors.push(
      'productIntegration.queryNavigation is retired: query-gated entries are opt-in candidates, not product integration',
    );
  }
  if (!Array.isArray(claim.mountChain) || claim.mountChain.length < 2) {
    errors.push('productIntegration.mountChain must include the real entry and final surface');
    return;
  }
  validateMountChain({ repoRoot, mountChain: claim.mountChain, label: 'productIntegration.mountChain', errors });
  validateDefaultEntryJourney({
    repoRoot,
    journey: claim.defaultEntryJourney,
    finalSurface: claim.mountChain.at(-1),
    errors,
  });
}

// `entry` is disclosure for contracts that do not claim product integration
// (opt-in candidates, hosted journeys). A disclosed mount chain must still be
// structurally true, otherwise the disclosure is stale.
function validateEntryDisclosure({ repoRoot, entry, errors }) {
  if (entry === undefined) return;
  if (!isRecord(entry)) {
    errors.push('entry must be an object');
    return;
  }
  if (entry.mountChain === undefined) return;
  if (!Array.isArray(entry.mountChain) || entry.mountChain.length < 2) {
    errors.push('entry.mountChain must list at least the entry and the final surface');
    return;
  }
  validateMountChain({ repoRoot, mountChain: entry.mountChain, label: 'entry.mountChain', errors });
}

function validateEditorEngineMetadata(engine, errors) {
  if (
    !isRecord(engine) ||
    !nonEmptyString(engine.package) ||
    !nonEmptyString(engine.version) ||
    !nonEmptyString(engine.license) ||
    !nonEmptyString(engine.source)
  ) {
    errors.push('documentEditor.engine needs package, version, license and source');
  }
}

function validateEditorManifest({ repoRoot, claim, engine, errors }) {
  const manifestAbsolutePath = insideRepo(repoRoot, claim.packageManifestPath);
  if (!manifestAbsolutePath || !existsSync(manifestAbsolutePath)) {
    errors.push(`documentEditor package manifest does not exist: ${claim.packageManifestPath ?? '<missing>'}`);
    return;
  }
  if (!nonEmptyString(engine?.package)) return;

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestAbsolutePath, 'utf8'));
  } catch (error) {
    errors.push(`documentEditor package manifest is not valid JSON: ${error.message}`);
    return;
  }
  const declaredVersion = [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.peerDependencies,
    manifest.optionalDependencies,
  ].find((dependencies) => nonEmptyString(dependencies?.[engine.package]))?.[engine.package];
  if (!declaredVersion) {
    errors.push(`documentEditor engine package is not declared: ${engine.package}`);
    return;
  }
  if (nonEmptyString(engine.version) && declaredVersion !== engine.version) {
    errors.push(
      `documentEditor engine version does not match manifest: contract=${engine.version} manifest=${declaredVersion}`,
    );
  }
}

function readEditorAdapterSource({ repoRoot, adapter, errors }) {
  const adapterAbsolutePath = insideRepo(repoRoot, adapter?.path);
  if (!adapterAbsolutePath || !existsSync(adapterAbsolutePath)) {
    errors.push(`documentEditor adapter path does not exist: ${adapter?.path ?? '<missing>'}`);
    return undefined;
  }
  if (!nonEmptyString(adapter?.export)) errors.push('documentEditor.adapter.export is required');
  return readFileSync(adapterAbsolutePath, 'utf8');
}

function validateEditorAdapterEngine({ adapterSource, engine, errors }) {
  if (nonEmptyString(engine?.package)) {
    const engineImportPattern = new RegExp(
      `from\\s+['"]${escapeRegExp(engine.package)}(?:/[^'"]*)?['"]|import\\s*\\(\\s*['"]${escapeRegExp(engine.package)}(?:/[^'"]*)?['"]\\s*\\)`,
      'u',
    );
    if (!engineImportPattern.test(adapterSource)) {
      errors.push(`documentEditor adapter must import declared engine ${engine.package}`);
    }
  }
  if (/<\s*textarea\b|\bcontentEditable\s*=/iu.test(adapterSource)) {
    errors.push('documentEditor adapter cannot use native textarea/contentEditable as its engine');
  }
}

function validateEditorContractTokens({ adapterSource, contracts, errors }) {
  for (const contractName of REQUIRED_EDITOR_CONTRACTS) {
    const tokens = contracts?.[contractName];
    if (!Array.isArray(tokens) || tokens.length === 0 || tokens.some((token) => !nonEmptyString(token))) {
      errors.push(`documentEditor contract ${contractName} needs implementation tokens`);
      continue;
    }
    for (const token of tokens) {
      if (!adapterSource.includes(token)) {
        errors.push(`documentEditor contract ${contractName} token is absent from adapter: ${token}`);
      }
    }
  }
}

function validateEditorClaim({ repoRoot, claim, errors }) {
  if (!isRecord(claim)) {
    errors.push('documentEditor claim must be an object');
    return;
  }

  validateEditorEngineMetadata(claim.engine, errors);
  validateEditorManifest({ repoRoot, claim, engine: claim.engine, errors });
  const adapterSource = readEditorAdapterSource({ repoRoot, adapter: claim.adapter, errors });
  if (adapterSource === undefined) return;
  validateEditorAdapterEngine({ adapterSource, engine: claim.engine, errors });
  validateEditorContractTokens({ adapterSource, contracts: claim.contracts, errors });

  importedAndMounted({
    repoRoot,
    parent: claim.mount,
    child: claim.adapter,
    errors,
    label: 'documentEditor mount',
  });
}

function validateCommittedContractLink({ repoRoot, contract, contractPath, errors }) {
  if (contractPath === '<memory>') return;
  const sourceFeature = contract.source?.feature;
  if (!nonEmptyString(sourceFeature)) {
    errors.push('source.feature is required for committed claim contracts');
  }
  const featureDocPath = contract.source?.featureDocPath;
  const featureDocAbsolutePath = insideRepo(repoRoot, featureDocPath);
  if (!featureDocAbsolutePath || !existsSync(featureDocAbsolutePath)) {
    errors.push(`source.featureDocPath does not exist: ${featureDocPath ?? '<missing>'}`);
    return;
  }
  const featureSource = readFileSync(featureDocAbsolutePath, 'utf8');
  const frontmatter = parseFeatureDocFrontmatter({ featureSource, featureDocPath, errors });
  if (!frontmatter) return;

  const featureIds = asStringList(frontmatter.feature_ids);
  if (nonEmptyString(sourceFeature) && !featureIds.includes(sourceFeature)) {
    errors.push(
      `source.feature ${sourceFeature} must match feature doc feature_ids: ${featureIds.join(', ') || '<missing>'}`,
    );
  }

  const normalizedContractPath = contractPath.split(sep).join('/');
  const declaredContracts = asStringList(frontmatter.design_gate_claim_contracts);
  if (!declaredContracts.includes(normalizedContractPath)) {
    errors.push(`feature doc must reference committed claim contract: ${contractPath}`);
  }
}

export function checkClaimContract({ repoRoot, contract, contractPath = '<memory>' }) {
  const errors = [];
  if (!isRecord(contract)) {
    return { ok: false, contractPath, errors: ['claim-evidence contract must be a JSON object'] };
  }
  if (contract.schemaVersion !== 1) errors.push('schemaVersion must equal 1');
  if (!nonEmptyString(contract.id)) errors.push('id is required');
  if (!nonEmptyString(contract.classification)) errors.push('classification is required');
  if (!isRecord(contract.claims)) errors.push('claims must be an object');
  validateCommittedContractLink({ repoRoot, contract, contractPath, errors });
  validateEntryDisclosure({ repoRoot, entry: contract.entry, errors });

  if (isRecord(contract.claims) && Object.hasOwn(contract.claims, 'productIntegration')) {
    validateProductIntegration({ repoRoot, claim: contract.claims.productIntegration, errors });
  }
  if (isRecord(contract.claims) && Object.hasOwn(contract.claims, 'documentEditor')) {
    validateEditorClaim({ repoRoot, claim: contract.claims.documentEditor, errors });
  }
  if (isRecord(contract.claims?.productIntegration) && isRecord(contract.claims?.documentEditor)) {
    const finalSurface = contract.claims.productIntegration.mountChain?.at(-1);
    const editorMount = contract.claims.documentEditor.mount;
    if (finalSurface?.path !== editorMount?.path || finalSurface?.export !== editorMount?.export) {
      errors.push('documentEditor mount must be the final surface in productIntegration.mountChain');
    }
  }

  return { ok: errors.length === 0, contractPath, errors };
}

function collectJsonFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectJsonFiles(entryPath));
    if (entry.isFile() && entry.name.endsWith('.json')) files.push(entryPath);
  }
  return files.sort();
}

export function checkClaimDirectory({ repoRoot, claimsDirectory = 'docs/design-gate-claims' }) {
  const directory = insideRepo(repoRoot, claimsDirectory);
  if (!directory) {
    return { ok: false, checked: 0, results: [], errors: [`claims directory escapes repo: ${claimsDirectory}`] };
  }
  const results = [];
  const errors = [];
  for (const absolutePath of collectJsonFiles(directory)) {
    const contractPath = relative(repoRoot, absolutePath);
    let contract;
    try {
      contract = JSON.parse(readFileSync(absolutePath, 'utf8'));
    } catch (error) {
      errors.push(`${contractPath}: invalid JSON: ${error.message}`);
      continue;
    }
    const result = checkClaimContract({ repoRoot, contract, contractPath });
    results.push(result);
    errors.push(...result.errors.map((error) => `${contractPath}: ${error}`));
  }
  return { ok: errors.length === 0, checked: results.length, results, errors };
}
