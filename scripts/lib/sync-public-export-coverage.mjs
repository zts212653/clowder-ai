import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SYNC_MANIFEST_PATH = 'sync-manifest.yaml';
const SYNC_SCRIPT_PATH = 'scripts/sync-to-opensource.sh';

function parseYamlPath(rawValue) {
  const withoutComment = rawValue.replace(/\s+#.*$/, '').trim();
  if (
    (withoutComment.startsWith('"') && withoutComment.endsWith('"')) ||
    (withoutComment.startsWith("'") && withoutComment.endsWith("'"))
  ) {
    return withoutComment.slice(1, -1);
  }
  return withoutComment;
}

function parseTopLevelList(manifestText, key) {
  const values = [];
  let inSection = false;
  for (const rawLine of manifestText.split(/\r?\n/)) {
    if (!inSection) {
      if (rawLine === `${key}:`) inSection = true;
      continue;
    }
    if (/^[^\s#-]/.test(rawLine)) break;
    const match = rawLine.match(/^\s{2}-\s+([^:]+?)\s*$/);
    if (!match) continue;
    const value = parseYamlPath(match[1]);
    if (value) values.push(value);
  }
  return values;
}

function parseTopLevelObjects(manifestText, key) {
  const records = [];
  let inSection = false;
  let current = null;
  for (const rawLine of manifestText.split(/\r?\n/)) {
    if (!inSection) {
      if (rawLine === `${key}:`) inSection = true;
      continue;
    }
    if (/^[^\s#-]/.test(rawLine)) break;

    const firstField = rawLine.match(/^\s{2}-\s+([A-Za-z0-9_-]+):\s+(.+?)\s*$/);
    if (firstField) {
      current = {};
      records.push(current);
      current[firstField[1]] = parseYamlPath(firstField[2]);
      continue;
    }

    const nestedField = rawLine.match(/^\s{4}([A-Za-z0-9_-]+):\s+(.+?)\s*$/);
    if (nestedField && current) current[nestedField[1]] = parseYamlPath(nestedField[2]);
  }
  return records;
}

function pathMatchesPrefix(path, prefix) {
  const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return path === normalized || path.startsWith(`${normalized}/`);
}

function isExcludedDirectoryPath(path, excluded) {
  return excluded.some((entry) => entry.endsWith('/') && pathMatchesPrefix(path, entry));
}

function readSyncScript(repoRoot) {
  const scriptPath = resolve(repoRoot, SYNC_SCRIPT_PATH);
  return existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : '';
}

function stripShellComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (char === '#' && quote === null && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index).trimEnd();
    }
  }
  return line;
}

function parseHeredocMarker(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '<<<' || token.startsWith('<<<')) continue;
    const marker = token === '<<' || token === '<<-' ? tokens[index + 1] : token.match(/^<<-?(.+)$/)?.[1];
    if (marker) return marker.replace(/^['"]|['"]$/g, '');
  }
  return null;
}

function logicalSyncScriptCommandRecords(syncScriptText) {
  const records = [];
  let current = '';
  let heredocMarker = null;
  let heredocBody = [];
  for (const rawLine of syncScriptText.split(/\r?\n/)) {
    if (heredocMarker !== null) {
      if (rawLine.trim() === heredocMarker) {
        records.push({ command: current.trim(), heredocBody: heredocBody.join('\n') });
        current = '';
        heredocMarker = null;
        heredocBody = [];
      } else {
        heredocBody.push(rawLine);
      }
      continue;
    }

    const uncommented = stripShellComment(rawLine);
    const trimmed = uncommented.trim();
    if (!current && trimmed.length === 0) continue;
    const continued = /\\\s*$/.test(uncommented);
    const fragment = uncommented.replace(/\\\s*$/, '').trim();
    current = current ? `${current} ${fragment}` : fragment;
    if (!continued) {
      const command = current.trim();
      if (command.length > 0) {
        const marker = parseHeredocMarker(tokenizeShellCommand(command));
        if (marker !== null) {
          heredocMarker = marker;
        } else {
          records.push({ command, heredocBody: '' });
          current = '';
        }
      }
    }
  }
  if (current.trim().length > 0) {
    records.push({ command: current.trim(), heredocBody: heredocBody.join('\n') });
  }
  return records;
}

function tokenizeShellCommand(command) {
  const tokens = [];
  let token = '';
  let quote = null;
  let escaped = false;

  const pushToken = () => {
    if (token.length === 0) return;
    tokens.push(token);
    token = '';
  };

  for (const char of command) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (/\s/.test(char) && quote === null) {
      pushToken();
      continue;
    }
    token += char;
  }
  pushToken();
  return tokens;
}

function filteredDirToken(path) {
  return [`$FILTERED_DIR/${path}`, `\${FILTERED_DIR}/${path}`];
}

function stagingDirToken(path) {
  return [`$STAGING_DIR/${path}`, `\${STAGING_DIR}/${path}`];
}

function tokenMatchesPath(token, pathTokens) {
  const normalized = token.replace(/^['"]|['"]$/g, '');
  return pathTokens.includes(normalized);
}

function commandName(tokens) {
  const command = tokens.find((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  return command?.split('/').pop() ?? '';
}

function commandHasRedirectionToTarget(tokens, target) {
  const targetTokens = filteredDirToken(target);
  return tokens.some((token, index) => {
    if (
      (token === '>' || token === '>>' || token === '>|') &&
      tokenMatchesPath(tokens[index + 1] ?? '', targetTokens)
    ) {
      return true;
    }
    return /^(?:>|>>|>\|)/.test(token) && tokenMatchesPath(token.replace(/^(?:>|>>|>\|)/, ''), targetTokens);
  });
}

function commandCopiesToTarget(tokens, target) {
  const targetTokens = filteredDirToken(target);
  const name = commandName(tokens);
  if (!['cp', 'install', 'mv', 'rsync'].includes(name)) return false;
  const targetIndex = tokens.findIndex((token) => tokenMatchesPath(token, targetTokens));
  if (targetIndex === -1) return false;
  const operandIndexes = tokens
    .map((token, index) => ({ token, index }))
    .filter(
      ({ token }) => !token.startsWith('-') && !['cp', 'install', 'mv', 'rsync'].includes(token.split('/').pop()),
    );
  return operandIndexes.at(-1)?.index === targetIndex;
}

function heredocWritesProcessArg(heredocBody, argIndex) {
  if (typeof heredocBody !== 'string' || heredocBody.length === 0 || argIndex < 0) return false;
  const processArgPattern = `process\\.argv\\[\\s*${argIndex}\\s*\\]`;
  const writeFileSyncCalleePattern = [
    '\\bwriteFileSync',
    '\\b[A-Za-z_$][\\w$]*\\.writeFileSync',
    `require\\(\\s*['"](?:node:)?fs['"]\\s*\\)\\.writeFileSync`,
  ].join('|');
  const writeFileSyncCall = new RegExp(`(?:${writeFileSyncCalleePattern})\\s*\\(\\s*${processArgPattern}`);
  return writeFileSyncCall.test(heredocBody);
}

function commandWritesTargetWithHelper(commandRecord, tokens, target) {
  const name = commandName(tokens);
  if (name !== 'node' || parseHeredocMarker(tokens) === null) return false;
  const targetIndex = tokens.findIndex((token) => tokenMatchesPath(token, filteredDirToken(target)));
  return heredocWritesProcessArg(commandRecord.heredocBody, targetIndex);
}

function syncScriptMaterializesTransform(syncScriptText, entry) {
  const commandRecords = logicalSyncScriptCommandRecords(syncScriptText);
  const sourceTokens =
    typeof entry.source === 'string' && entry.source.length > 0 ? stagingDirToken(entry.source) : null;
  return commandRecords.some((commandRecord) => {
    const tokens = tokenizeShellCommand(commandRecord.command);
    if (sourceTokens !== null && !tokens.some((token) => tokenMatchesPath(token, sourceTokens))) return false;
    return (
      commandCopiesToTarget(tokens, entry.target) ||
      commandHasRedirectionToTarget(tokens, entry.target) ||
      commandWritesTargetWithHelper(commandRecord, tokens, entry.target)
    );
  });
}

function isCoveredByListedExport(path, coverage) {
  if (isExcludedDirectoryPath(path, coverage.excluded)) return false;
  if (coverage.excluded.some((entry) => !entry.endsWith('/') && pathMatchesPrefix(path, entry))) return false;
  if (coverage.exact.includes(path)) return true;
  return coverage.prefixes.some((entry) => pathMatchesPrefix(path, entry));
}

function transformIsMaterialized(entry, coverage, syncScriptText) {
  if (entry.type === 'sanitize') return isCoveredByListedExport(entry.target, coverage);
  return syncScriptMaterializesTransform(syncScriptText, entry);
}

export function loadPublicExportCoverage(repoRoot) {
  const manifestPath = resolve(repoRoot, SYNC_MANIFEST_PATH);
  if (!existsSync(manifestPath)) return null;
  const manifestText = readFileSync(manifestPath, 'utf8');
  const docsGeneratedTargets = parseTopLevelObjects(manifestText, 'docs_generated')
    .map((entry) => entry.target)
    .filter((path) => typeof path === 'string' && path.length > 0);
  const transformEntries = parseTopLevelObjects(manifestText, 'transforms').filter(
    (entry) => typeof entry.target === 'string' && entry.target.length > 0,
  );
  const transformExactEntries = transformEntries.filter((entry) => !entry.target.endsWith('/'));
  const syncScriptText = readSyncScript(repoRoot);
  const coverage = {
    excluded: parseTopLevelList(manifestText, 'excluded'),
    transformExactByTarget: new Map(transformExactEntries.map((entry) => [entry.target, entry])),
    prefixes: [
      ...parseTopLevelList(manifestText, 'managed_roots'),
      ...docsGeneratedTargets.filter((path) => path.endsWith('/')),
      ...parseTopLevelList(manifestText, 'docs_runtime_assets_allowlist').filter((path) => path.endsWith('/')),
    ],
    exact: [
      ...parseTopLevelList(manifestText, 'managed_files'),
      ...parseTopLevelList(manifestText, 'managed_scripts'),
      ...parseTopLevelList(manifestText, 'docs_decisions_allowlist'),
      ...parseTopLevelList(manifestText, 'docs_runtime_assets_allowlist').filter((path) => !path.endsWith('/')),
      ...docsGeneratedTargets.filter((path) => !path.endsWith('/')),
    ],
  };
  coverage.materializedTransformExact = transformExactEntries
    .filter((entry) => transformIsMaterialized(entry, coverage, syncScriptText))
    .map((entry) => entry.target);
  return coverage;
}

export function isCoveredByPublicExport(path, coverage) {
  if (isExcludedDirectoryPath(path, coverage.excluded)) return false;
  if (coverage.materializedTransformExact.includes(path)) return true;
  return isCoveredByListedExport(path, coverage);
}

function workingTreeReferenceStatus(repoRoot, sourceRef) {
  const path = resolve(repoRoot, sourceRef.path);
  if (!existsSync(path)) return 'missing path';
  return readFileSync(path, 'utf8').includes(sourceRef.anchor) ? 'ok' : 'missing anchor';
}

function transformedReferenceStatus(repoRoot, sourceRef, coverage) {
  const transform = coverage?.transformExactByTarget?.get(sourceRef.path);
  if (!transform) return null;
  if (typeof transform.source !== 'string' || transform.source.length === 0) return null;
  if (!coverage.materializedTransformExact.includes(sourceRef.path)) return 'missing transform output';
  const path = resolve(repoRoot, transform.source);
  if (!existsSync(path)) return 'missing transform source';
  return readFileSync(path, 'utf8').includes(sourceRef.anchor) ? 'ok' : 'missing anchor';
}

export function candidateReferenceStatus(repoRoot, sourceRef, coverage) {
  return transformedReferenceStatus(repoRoot, sourceRef, coverage) ?? workingTreeReferenceStatus(repoRoot, sourceRef);
}
