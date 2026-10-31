#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const INVALID_THINKING_SIGNATURE_RE = /Invalid [`'"]?signature[`'"]? in [`'"]?thinking[`'"]? block/i;

const HELP = `Usage:
  node scripts/rescue-claude-thinking-signature.mjs --session <sessionId> [--session <sessionId>...]
  node scripts/rescue-claude-thinking-signature.mjs --all-broken

Options:
  --session <id>     Repair a specific Claude session transcript by session id
  --all-broken       Scan ~/.claude/projects for broken sessions (API error entries or empty/short signatures)
  --root <dir>       Override Claude projects root (default: ~/.claude/projects)
  --backup-dir <dir> Override backup directory (default: ~/.claude/backups)
  --dry-run          Print what would change without writing files
  -h, --help         Show this help
`;

function defaultProjectsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

function defaultBackupDir() {
  return path.join(os.homedir(), '.claude', 'backups');
}

function readRequiredValue(argv, index, flagName) {
  const value = argv[index + 1];
  if (typeof value !== 'string' || value.length === 0 || value === '--' || value.startsWith('--')) {
    throw new Error(`${flagName} requires a value`);
  }
  return value;
}

const MIN_VALID_SIGNATURE_LENGTH = 300;

export function hasShortThinkingSignature(entry) {
  if (!entry || typeof entry !== 'object' || entry.type !== 'assistant') return false;
  if (!entry.message || entry.message.role !== 'assistant' || !Array.isArray(entry.message.content)) return false;
  return entry.message.content.some(
    (item) =>
      item &&
      typeof item === 'object' &&
      item.type === 'thinking' &&
      typeof item.signature === 'string' &&
      item.signature.length < MIN_VALID_SIGNATURE_LENGTH,
  );
}

export function isPureThinkingAssistantTurn(entry) {
  if (!entry || typeof entry !== 'object' || entry.type !== 'assistant') return false;
  if (!entry.message || entry.message.role !== 'assistant' || !Array.isArray(entry.message.content)) return false;
  return (
    entry.message.content.length > 0 &&
    entry.message.content.every(
      (item) => item && typeof item === 'object' && item.type === 'thinking' && typeof item.signature === 'string',
    )
  );
}

export function stripPureThinkingAssistantTurns(rawContent) {
  const lines = rawContent.split('\n');
  const keptLines = [];
  let removedCount = 0;

  for (const line of lines) {
    if (line.trim().length === 0) {
      keptLines.push(line);
      continue;
    }

    try {
      const parsed = JSON.parse(line);
      if (isPureThinkingAssistantTurn(parsed)) {
        removedCount++;
        continue;
      }
    } catch {
      // Keep malformed lines untouched; rescue focuses on known-good pure thinking entries.
    }

    keptLines.push(line);
  }

  return {
    content: keptLines.join('\n'),
    removedCount,
  };
}

function hasBrokenThinkingSignature(rawContent) {
  if (INVALID_THINKING_SIGNATURE_RE.test(rawContent)) return true;

  for (const line of rawContent.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      if (hasShortThinkingSignature(JSON.parse(line))) return true;
    } catch {
      // Ignore malformed lines while scanning; they are not rescue targets.
    }
  }

  return false;
}

async function walkJsonlFiles(rootDir) {
  const results = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) results.push(fullPath);
    }
  }

  return results.sort();
}

export async function findBrokenSessionFiles(rootDir = defaultProjectsRoot()) {
  const files = await walkJsonlFiles(rootDir);
  const broken = [];

  for (const filePath of files) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      if (hasBrokenThinkingSignature(content)) broken.push(filePath);
    } catch {
      // Ignore unreadable files and keep scanning the rest.
    }
  }

  return broken;
}

async function findSessionFile(rootDir, sessionId) {
  const files = await walkJsonlFiles(rootDir);
  return files.find((filePath) => path.basename(filePath, '.jsonl') === sessionId);
}

function backupPathFor(sessionId, backupDir, now) {
  const unixSeconds = Math.floor(now / 1000);
  return path.join(backupDir, `${sessionId}.pre-strip-thinking-${unixSeconds}.jsonl`);
}

export async function repairSessionFile(
  filePath,
  { backupDir = defaultBackupDir(), dryRun = false, now = Date.now() } = {},
) {
  const sessionId = path.basename(filePath, '.jsonl');
  const original = await fs.readFile(filePath, 'utf8');
  const stripped = stripPureThinkingAssistantTurns(original);

  if (stripped.removedCount === 0) {
    return { filePath, sessionId, status: 'clean', removedCount: 0, backupPath: null };
  }

  const backupPath = backupPathFor(sessionId, backupDir, now);
  if (!dryRun) {
    await fs.mkdir(backupDir, { recursive: true });
    await fs.copyFile(filePath, backupPath);
    await fs.writeFile(filePath, stripped.content, 'utf8');
  }

  return {
    filePath,
    sessionId,
    status: dryRun ? 'would_repair' : 'repaired',
    removedCount: stripped.removedCount,
    backupPath,
  };
}

function parseArgs(argv) {
  const args = {
    sessions: [],
    allBroken: false,
    dryRun: false,
    rootDir: defaultProjectsRoot(),
    backupDir: defaultBackupDir(),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--session') {
      const sessionId = readRequiredValue(argv, i, '--session');
      i += 1;
      args.sessions.push(sessionId);
    } else if (arg === '--all-broken') {
      args.allBroken = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--root') {
      const dir = readRequiredValue(argv, i, '--root');
      i += 1;
      args.rootDir = path.resolve(dir);
    } else if (arg === '--backup-dir') {
      const dir = readRequiredValue(argv, i, '--backup-dir');
      i += 1;
      args.backupDir = path.resolve(dir);
    } else if (arg === '-h' || arg === '--help') {
      console.log(HELP);
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${arg}`);
    }
  }

  if (!args.allBroken && args.sessions.length === 0) {
    throw new Error('Specify at least one --session <id> or use --all-broken');
  }

  return args;
}

async function resolveTargets(args) {
  if (args.allBroken) return findBrokenSessionFiles(args.rootDir);

  const resolved = [];
  for (const sessionId of args.sessions) {
    const filePath = await findSessionFile(args.rootDir, sessionId);
    if (!filePath) {
      resolved.push({ sessionId, status: 'missing' });
      continue;
    }
    resolved.push(filePath);
  }
  return resolved;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = await resolveTargets(args);
  const results = [];

  for (const target of targets) {
    if (typeof target === 'string') {
      results.push(await repairSessionFile(target, { backupDir: args.backupDir, dryRun: args.dryRun }));
    } else {
      results.push({ ...target, removedCount: 0, backupPath: null });
    }
  }

  if (results.length === 0) {
    console.log('No broken Claude session transcripts found.');
    return;
  }

  for (const result of results) {
    const suffix = result.backupPath ? ` backup=${result.backupPath}` : '';
    console.log(`${result.status}: ${result.sessionId} removed=${result.removedCount ?? 0}${suffix}`);
  }

  const repairedCount = results.filter(
    (result) => result.status === 'repaired' || result.status === 'would_repair',
  ).length;
  const missingCount = results.filter((result) => result.status === 'missing').length;
  if (missingCount > 0) process.exitCode = 1;
  else if (repairedCount === 0) process.exitCode = 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
