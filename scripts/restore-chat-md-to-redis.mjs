#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import Redis from 'ioredis';

const CAT_SPEAKERS = [
  { catId: 'opus', tokens: ['布偶', 'opus', 'claude'] },
  { catId: 'codex', tokens: ['缅因', 'codex', 'maine'] },
  { catId: 'gemini', tokens: ['暹罗', 'gemini'] },
];
const HELP = `Usage: node scripts/restore-chat-md-to-redis.mjs [--apply --yes] [--redis-url <url>] [--docs-root <dir>] [--user-id <id>]

Defaults:
  --docs-root  docs
  --redis-url  REDIS_URL or redis://127.0.0.1:6399
  --user-id    default-user

Safety:
  dry-run is default
  --apply requires --yes
`;

function parseArgs(argv) {
  const out = {
    apply: false,
    yes: false,
    docsRoot: path.resolve(process.cwd(), 'docs'),
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6399',
    userId: 'default-user',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--yes') out.yes = true;
    else if (a === '--docs-root') out.docsRoot = path.resolve(process.cwd(), argv[++i] ?? '');
    else if (a === '--redis-url') out.redisUrl = argv[++i] ?? '';
    else if (a === '--user-id') out.userId = argv[++i] ?? '';
    else if (a === '-h' || a === '--help') {
      console.log(HELP);
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  if (out.apply && !out.yes) throw new Error('Refusing to apply without --yes');
  return out;
}

function walkMdFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || !fs.existsSync(cur)) continue;
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && ent.name.endsWith('.md')) files.push(full);
    }
  }
  return files.sort();
}

function parseDateBase(text) {
  const m = text.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}

function speakerToCatId(raw) {
  const s = raw.trim().toLowerCase();
  for (const r of CAT_SPEAKERS) if (r.tokens.some((t) => s.includes(t))) return r.catId;
  return null;
}

function parseMentions(content) {
  const got = new Set();
  if (/@(布偶|opus)/i.test(content)) got.add('opus');
  if (/@(缅因|codex)/i.test(content)) got.add('codex');
  if (/@(暹罗|gemini)/i.test(content)) got.add('gemini');
  return [...got];
}

function cleanContent(lines) {
  const out = [...lines];
  while (out.length > 0) {
    const tail = out[out.length - 1].trim();
    if (!tail || tail === '---' || /^\*\[[^\]]+\]\*$/.test(tail) || /^\*?导出时间[:：]/.test(tail)) out.pop();
    else break;
  }
  return out.join('\n').trim();
}

function parseConversation(file, userId) {
  const text = fs.readFileSync(file, 'utf8');
  const threadId = text.match(/^- \*\*ID\*\*:\s*(thread_[a-z0-9]+)/im)?.[1];
  if (!threadId) return null;
  const dateBase = parseDateBase(text.match(/^- \*\*时间\*\*:\s*([^\n~]+)/im)?.[1] ?? '');
  if (!dateBase) return null;
  const title = text.match(/^# 对话记录:\s*(.+)$/m)?.[1]?.trim() ?? threadId;
  const participantsRaw = text.match(/^- \*\*参与者\*\*:\s*(.+)$/im)?.[1] ?? '';
  const participants = new Set();
  for (const p of participantsRaw
    .split(/[，,]/)
    .map((v) => v.trim())
    .filter(Boolean)) {
    const catId = speakerToCatId(p);
    if (catId) participants.add(catId);
  }

  const lines = text.split(/\r?\n/);
  const msgRe = /^\[(\d{2}):(\d{2})(?::(\d{2}))?\s+([^\]]+)\]\s*(.*)$/;
  const messages = [];
  let cur = null;
  let dayOffset = 0;
  let lastTs = 0;

  const flush = () => {
    if (!cur) return;
    const content = cleanContent(cur.lines);
    if (!content) return;
    const catId = speakerToCatId(cur.speaker);
    const mentions = parseMentions(content);
    if (catId) participants.add(catId);
    for (const m of mentions) participants.add(m);
    messages.push({
      sourceFile: file,
      sourceLine: cur.line,
      threadId,
      title,
      speaker: cur.speaker,
      timestamp: cur.ts,
      userId,
      catId,
      content,
      mentions,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(msgRe);
    if (!m) {
      if (cur) cur.lines.push(lines[i]);
      continue;
    }
    flush();
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    const ss = Number(m[3] ?? '0');
    let ts = new Date(dateBase.y, dateBase.mo - 1, dateBase.d + dayOffset, hh, mm, ss, 0).getTime();
    if (lastTs !== 0 && ts + 60_000 < lastTs) {
      dayOffset += 1;
      ts = new Date(dateBase.y, dateBase.mo - 1, dateBase.d + dayOffset, hh, mm, ss, 0).getTime();
    }
    lastTs = ts;
    cur = { ts, speaker: m[4].trim(), lines: [m[5] ?? ''], line: i + 1 };
  }
  flush();
  if (messages.length === 0) return null;
  return { threadId, title, participants: [...participants], messages };
}

function buildRecovery(conversations, userId) {
  const dedup = new Map();
  for (const c of conversations) {
    for (const m of c.messages) {
      const key = `${m.threadId}|${m.timestamp}|${m.speaker}|${m.content}`;
      if (!dedup.has(key)) dedup.set(key, m);
    }
  }
  const msgs = [...dedup.values()].sort(
    (a, b) => a.timestamp - b.timestamp || a.sourceFile.localeCompare(b.sourceFile) || a.sourceLine - b.sourceLine,
  );
  msgs.forEach((m, idx) => {
    const hash = crypto
      .createHash('sha1')
      .update(`${m.threadId}\n${m.timestamp}\n${m.speaker}\n${m.content}`)
      .digest('hex')
      .slice(0, 8);
    m.id = `${String(m.timestamp).padStart(16, '0')}-${String(idx).padStart(6, '0')}-${hash}`;
  });

  const threads = new Map();
  for (const c of conversations) {
    const existing = threads.get(c.threadId) ?? {
      id: c.threadId,
      title: c.title,
      participants: new Set(),
      createdAt: Number.MAX_SAFE_INTEGER,
      lastActiveAt: 0,
    };
    for (const p of c.participants) existing.participants.add(p);
    threads.set(c.threadId, existing);
  }
  for (const m of msgs) {
    const t = threads.get(m.threadId);
    if (!t) continue;
    if (m.catId) t.participants.add(m.catId);
    m.mentions.forEach((x) => t.participants.add(x));
    t.createdAt = Math.min(t.createdAt, m.timestamp);
    t.lastActiveAt = Math.max(t.lastActiveAt, m.timestamp);
  }
  const threadList = [...threads.values()].map((t) => ({
    ...t,
    participants: [...t.participants],
    userId,
    projectPath: 'default',
    createdBy: userId,
  }));
  return { threads: threadList, messages: msgs };
}

async function backupBeforeApply(redis) {
  await redis.bgsave().catch(() => undefined);
  await new Promise((r) => setTimeout(r, 250));
  const dir = (await redis.config('GET', 'dir'))?.[1];
  const dbfile = (await redis.config('GET', 'dbfilename'))?.[1];
  if (!dir || !dbfile) return null;
  const source = path.join(dir, dbfile);
  if (!fs.existsSync(source)) return null;
  const backupDir = path.join(os.homedir(), '.cat-cafe', 'redis-backups', 'recovery');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replaceAll(':', '')
    .replaceAll('-', '')
    .replace('T', '-')
    .replace('Z', '')
    .slice(0, 18);
  const port = String(redis.options.port ?? 'unknown');
  const target = path.join(backupDir, `md-restore-preapply-p${port}-${stamp}.rdb`);
  fs.copyFileSync(source, target);
  return target;
}

async function countMsgKeysRaw(redisUrl) {
  const raw = new Redis(redisUrl);
  try {
    let cursor = '0';
    let total = 0;
    do {
      const out = await raw.scan(cursor, 'MATCH', 'cat-cafe:msg:*', 'COUNT', 1000);
      cursor = out[0];
      total += out[1].length;
    } while (cursor !== '0');
    return total;
  } finally {
    await raw.quit();
  }
}

async function applyRecovery(redis, data) {
  let pipe = redis.multi();
  let n = 0;
  const flush = async () => {
    if (n === 0) return;
    await pipe.exec();
    pipe = redis.multi();
    n = 0;
  };
  for (const t of data.threads) {
    pipe.hset(`thread:${t.id}`, {
      id: t.id,
      projectPath: t.projectPath,
      title: t.title ?? '',
      createdBy: t.createdBy,
      lastActiveAt: String(t.lastActiveAt),
      createdAt: String(t.createdAt),
    });
    pipe.zadd(`threads:user:${t.userId}`, String(t.lastActiveAt), t.id);
    if (t.participants.length > 0) pipe.sadd(`thread:${t.id}:participants`, ...t.participants);
    n += 3;
    if (n >= 400) await flush();
  }
  for (const m of data.messages) {
    pipe.hset(`msg:${m.id}`, {
      id: m.id,
      threadId: m.threadId,
      userId: m.userId,
      catId: m.catId ?? '',
      content: m.content,
      contentBlocks: '',
      metadata: '',
      mentions: JSON.stringify(m.mentions),
      timestamp: String(m.timestamp),
    });
    pipe.zadd('msg:timeline', String(m.timestamp), m.id);
    pipe.zadd(`msg:user:${m.userId}`, String(m.timestamp), m.id);
    pipe.zadd(`msg:thread:${m.threadId}`, String(m.timestamp), m.id);
    for (const catId of m.mentions) pipe.zadd(`msg:mentions:${catId}`, String(m.timestamp), m.id);
    n += 4 + m.mentions.length;
    if (n >= 400) await flush();
  }
  await flush();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = walkMdFiles(args.docsRoot);
  const conversations = files.map((f) => parseConversation(f, args.userId)).filter(Boolean);
  const data = buildRecovery(conversations, args.userId);
  const redis = new Redis(args.redisUrl, { keyPrefix: 'cat-cafe:' });
  await redis.ping();
  const beforeDbsize = Number(await redis.dbsize());
  const beforeMsgKeys = await countMsgKeysRaw(args.redisUrl);

  console.log(`[restore] mode=${args.apply ? 'apply' : 'dry-run'} redis=${args.redisUrl}`);
  console.log(
    `[restore] files=${files.length} parsed=${conversations.length} threads=${data.threads.length} messages=${data.messages.length}`,
  );
  console.log(`[restore] redis-before dbsize=${beforeDbsize} msgKeys=${beforeMsgKeys}`);
  for (const t of data.threads) {
    const count = data.messages.filter((m) => m.threadId === t.id).length;
    console.log(`  - ${t.id}: messages=${count} participants=${t.participants.join(',') || '-'}`);
  }

  if (!args.apply) {
    await redis.quit();
    return;
  }

  const backup = await backupBeforeApply(redis);
  console.log(`[restore] pre-apply backup: ${backup ?? '(skip: no source dump found)'}`);
  await applyRecovery(redis, data);
  const afterDbsize = Number(await redis.dbsize());
  const afterMsgKeys = await countMsgKeysRaw(args.redisUrl);
  console.log(`[restore] redis-after dbsize=${afterDbsize} msgKeys=${afterMsgKeys}`);
  await redis.quit();
}

main().catch((err) => {
  console.error(`[restore] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
