#!/usr/bin/env node

import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const INVALID_THINKING_SIGNATURE_RE = /Invalid [`'"]?signature[`'"]? in [`'"]?thinking[`'"]? block/i;
const MIN_VALID_SIGNATURE_LENGTH = 300;

function usage() {
  console.log(`Usage:
  pnpm rescue:claude:thinking -- --all-broken [--dry-run]
  pnpm rescue:claude:thinking -- --session <sessionId> [--session <sessionId> ...] [--dry-run]

Options:
  --all-broken          Rescue every detected broken Claude transcript
  --session <id>        Rescue one specific session (repeatable)
  --dry-run             Report what would change without writing
  --root-dir <path>     Override ~/.claude/projects
  --backup-dir <path>   Override ~/.claude/backups
`);
}

function readRequiredValue(argv, index, flagName) {
  const value = argv[index + 1];
  if (typeof value !== 'string' || value.length === 0 || value === '--' || value.startsWith('--')) {
    throw new Error(`${flagName} requires a value.`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    allBroken: false,
    dryRun: false,
    sessionIds: [],
    rootDir: path.join(os.homedir(), '.claude', 'projects'),
    backupDir: path.join(os.homedir(), '.claude', 'backups'),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--':
        break;
      case '--all-broken':
        options.allBroken = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--session':
        options.sessionIds.push(readRequiredValue(argv, i, '--session'));
        i += 1;
        break;
      case '--root-dir':
        options.rootDir = readRequiredValue(argv, i, '--root-dir');
        i += 1;
        break;
      case '--backup-dir':
        options.backupDir = readRequiredValue(argv, i, '--backup-dir');
        i += 1;
        break;
      case '--help':
      case '-h':
        usage();
        process.exit(0);
        return;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.allBroken && options.sessionIds.length === 0) {
    throw new Error('Provide --all-broken or at least one --session <id>.');
  }

  return options;
}

function hasShortThinkingSignature(entry) {
  if (!entry || typeof entry !== 'object' || entry.type !== 'assistant') return false;
  if (!entry.message || entry.message.role !== 'assistant' || !Array.isArray(entry.message.content)) return false;
  return entry.message.content.some(
    (item) =>
      item &&
      typeof item === 'object' &&
      item.type === 'thinking' &&
      typeof item.signature === 'string' &&
      item.signature.length > 0 &&
      item.signature.length < MIN_VALID_SIGNATURE_LENGTH,
  );
}

function isPureThinkingAssistantTurn(entry) {
  if (!entry || typeof entry !== 'object' || entry.type !== 'assistant') return false;
  if (!entry.message || entry.message.role !== 'assistant' || !Array.isArray(entry.message.content)) return false;
  return (
    entry.message.content.length > 0 &&
    entry.message.content.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        item.type === 'thinking' &&
        typeof item.signature === 'string' &&
        item.signature.length > 0,
    )
  );
}

function isThinkingSignatureApiErrorEntry(entry) {
  if (!entry || typeof entry !== 'object' || entry.type !== 'assistant' || entry.isApiErrorMessage !== true)
    return false;
  if (!entry.message || entry.message.role !== 'assistant' || !Array.isArray(entry.message.content)) return false;
  return entry.message.content.some(
    (item) =>
      item &&
      typeof item === 'object' &&
      item.type === 'text' &&
      typeof item.text === 'string' &&
      INVALID_THINKING_SIGNATURE_RE.test(item.text),
  );
}

function stripPureThinkingAssistantTurns(rawContent) {
  const kept = [];
  let removedCount = 0;

  for (const line of rawContent.split('\n')) {
    if (line.trim().length === 0) {
      kept.push(line);
      continue;
    }

    try {
      const parsed = JSON.parse(line);
      if (isPureThinkingAssistantTurn(parsed)) {
        removedCount += 1;
        continue;
      }
    } catch {
      // Keep malformed lines untouched.
    }

    kept.push(line);
  }

  return { content: kept.join('\n'), removedCount };
}

async function walkJsonlFiles(rootDir) {
  const stack = [rootDir];
  const results = [];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) results.push(fullPath);
    }
  }

  return results.sort();
}

async function findBrokenSessions(rootDir) {
  const files = await walkJsonlFiles(rootDir);
  const sessions = [];

  for (const transcriptPath of files) {
    let content;
    try {
      content = await fs.readFile(transcriptPath, 'utf8');
    } catch {
      continue;
    }

    let removableThinkingTurns = 0;
    let hasApiErrorEntry = false;
    let hasShortSignature = false;

    for (const line of content.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line);
        if (isPureThinkingAssistantTurn(parsed)) removableThinkingTurns += 1;
        if (isThinkingSignatureApiErrorEntry(parsed)) hasApiErrorEntry = true;
        if (hasShortThinkingSignature(parsed)) hasShortSignature = true;
      } catch {
        // Ignore malformed lines during scan.
      }
    }

    if (!hasApiErrorEntry && !hasShortSignature) continue;

    sessions.push({
      sessionId: path.basename(transcriptPath, '.jsonl'),
      transcriptPath,
      removableThinkingTurns,
      detectedBy: hasApiErrorEntry ? 'api_error_entry' : 'short_signature',
    });
  }

  return sessions;
}

function backupPathFor(sessionId, backupDir, now) {
  return path.join(backupDir, `${sessionId}.pre-strip-thinking-${Math.floor(now / 1000)}.jsonl`);
}

async function repairTranscript(target, options) {
  let original;
  try {
    original = await fs.readFile(target.transcriptPath, 'utf8');
  } catch {
    return {
      sessionId: target.sessionId,
      status: 'missing',
      removedTurns: 0,
      backupPath: null,
      reason: 'transcript_unreadable',
    };
  }

  const stripped = stripPureThinkingAssistantTurns(original);
  if (stripped.removedCount === 0) {
    return {
      sessionId: target.sessionId,
      status: 'unrescued',
      removedTurns: 0,
      backupPath: null,
      reason: 'no_safe_turns_to_strip',
    };
  }

  const backupPath = backupPathFor(target.sessionId, options.backupDir, options.now);
  if (!options.dryRun) {
    await fs.mkdir(options.backupDir, { recursive: true });
    await fs.copyFile(target.transcriptPath, backupPath);
    await fs.writeFile(target.transcriptPath, stripped.content, 'utf8');
  }

  return {
    sessionId: target.sessionId,
    status: 'repaired',
    removedTurns: stripped.removedCount,
    backupPath,
  };
}

try {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(options.rootDir)) {
    console.error(`Claude projects root does not exist: ${options.rootDir}`);
    process.exit(1);
  }

  const scan = await findBrokenSessions(options.rootDir);
  const selected = options.allBroken ? scan : scan.filter((item) => options.sessionIds.includes(item.sessionId));

  if (selected.length === 0) {
    console.log('No matching broken Claude sessions found.');
    process.exit(0);
  }

  console.log(`Found ${selected.length} broken Claude session(s).`);
  for (const item of selected) {
    console.log(`- ${item.sessionId} (${item.detectedBy}, removable thinking turns=${item.removableThinkingTurns})`);
  }

  const results = [];
  for (const target of selected) {
    results.push(
      await repairTranscript(target, { backupDir: options.backupDir, dryRun: options.dryRun, now: Date.now() }),
    );
  }

  const rescuedCount = results.filter((item) => item.status === 'repaired').length;
  const skippedCount = results.length - rescuedCount;
  const failedCount = results.filter((item) => item.status === 'unrescued').length;

  console.log('');
  console.log(options.dryRun ? 'Dry run summary' : 'Rescue summary');
  console.log(`rescued=${rescuedCount} skipped=${skippedCount}`);
  for (const result of results) {
    const backupSuffix = result.backupPath ? ` backup=${result.backupPath}` : '';
    const reasonSuffix = result.reason ? ` reason=${result.reason}` : '';
    console.log(`- ${result.sessionId}: ${result.status} removed=${result.removedTurns}${backupSuffix}${reasonSuffix}`);
  }

  if (failedCount > 0) {
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exit(1);
}
