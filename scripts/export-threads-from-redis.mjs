#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import Redis from 'ioredis';

const HELP = `Usage: node scripts/export-threads-from-redis.mjs [--redis-url <url>] [--out-dir <dir>] [--thread-id <id>] [--dry-run]

Defaults:
  --redis-url  REDIS_URL or redis://127.0.0.1:6399
  --out-dir    docs/discussions/exported-threads
`;

function parseArgs(argv) {
  const out = {
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6399',
    outDir: path.resolve(process.cwd(), 'docs/discussions/exported-threads'),
    threadIds: [],
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--redis-url') out.redisUrl = argv[++i] ?? '';
    else if (a === '--out-dir') out.outDir = path.resolve(process.cwd(), argv[++i] ?? '');
    else if (a === '--thread-id') out.threadIds.push(argv[++i] ?? '');
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '-h' || a === '--help') {
      console.log(HELP);
      process.exit(0);
    } else throw new Error(`Unknown arg: ${a}`);
  }
  return out;
}

function fmt(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function catLabel(catId) {
  if (catId === 'opus') return '布偶猫';
  if (catId === 'codex') return '缅因猫';
  if (catId === 'gemini') return '暹罗猫';
  return null;
}

function userLabel(userId) {
  if (userId === 'default-user') return '铲屎官';
  return userId || '用户';
}

function parseMentions(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function parseMetadata(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

async function scanAll(redis, pattern) {
  let cursor = '0';
  const out = [];
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
    cursor = next;
    out.push(...keys);
  } while (cursor !== '0');
  return out;
}

async function loadMessages(redis, threadId) {
  const ids = await redis.zrange(`cat-cafe:msg:thread:${threadId}`, 0, -1);
  if (ids.length === 0) return [];
  const msgs = [];
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const pipeline = redis.pipeline();
    for (const id of chunk) pipeline.hgetall(`cat-cafe:msg:${id}`);
    const rows = await pipeline.exec();
    for (let j = 0; j < rows.length; j++) {
      const data = rows[j]?.[1];
      if (!data || typeof data !== 'object' || !data.id) continue;
      msgs.push({
        id: data.id,
        threadId: data.threadId || threadId,
        userId: data.userId || 'default-user',
        catId: data.catId || null,
        content: data.content || '',
        mentions: parseMentions(data.mentions),
        metadata: parseMetadata(data.metadata),
        timestamp: Number(data.timestamp || 0),
      });
    }
  }
  msgs.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  return msgs;
}

function toMarkdown(threadId, threadMeta, participants, messages) {
  const title = threadMeta?.title || threadId;
  const startTs = messages[0]?.timestamp ?? Number(threadMeta?.createdAt ?? Date.now());
  const endTs = messages[messages.length - 1]?.timestamp ?? Number(threadMeta?.lastActiveAt ?? startTs);
  const participantLabels = Array.from(participants)
    .map((p) => catLabel(p) ?? p)
    .join(', ');

  const lines = [];
  lines.push(`# 对话记录: ${title}`, '');
  lines.push(`- **ID**: ${threadId}`);
  lines.push(`- **时间**: ${fmt(startTs)} ~ ${fmt(endTs)}`);
  lines.push(`- **参与者**: ${participantLabels || '未知'}`);
  lines.push(`- **消息数**: ${messages.length}`);
  lines.push('', '---', '');

  for (const m of messages) {
    const speaker = m.catId ? (catLabel(m.catId) ?? m.catId) : userLabel(m.userId);
    lines.push(`[${fmtTime(m.timestamp)} ${speaker}] ${m.content}`.trimEnd());
    const model = m.metadata?.model ?? m.metadata?.providerModel;
    if (m.catId && model) {
      lines.push(`*[${model}]*`);
    }
  }

  lines.push('', '---', `*导出时间: ${fmt(Date.now())}*`);
  return `${lines.join('\n')}\n`;
}

function sameContent(file, content) {
  if (!fs.existsSync(file)) return false;
  try {
    return fs.readFileSync(file, 'utf8') === content;
  } catch {
    return false;
  }
}

async function findThreadIds(redis, explicit) {
  if (explicit.length > 0) return [...new Set(explicit.filter(Boolean))];
  const ids = new Set();
  const threadKeys = await scanAll(redis, 'cat-cafe:msg:thread:*');
  for (const key of threadKeys) {
    const id = key.slice('cat-cafe:msg:thread:'.length);
    if (id) ids.add(id);
  }
  const threadMeta = await scanAll(redis, 'cat-cafe:thread:thread_*');
  for (const key of threadMeta) {
    const id = key.slice('cat-cafe:thread:'.length);
    if (!id) continue;
    if (id.includes(':')) continue;
    ids.add(id);
  }
  return [...ids].sort();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const redis = new Redis(args.redisUrl);
  await redis.ping();
  const threadIds = await findThreadIds(redis, args.threadIds);
  if (!args.dryRun) fs.mkdirSync(args.outDir, { recursive: true });

  let exported = 0;
  let updated = 0;
  for (const threadId of threadIds) {
    const [meta, participantsRaw, messages] = await Promise.all([
      redis.hgetall(`cat-cafe:thread:${threadId}`),
      redis.smembers(`cat-cafe:thread:${threadId}:participants`),
      loadMessages(redis, threadId),
    ]);
    if (messages.length === 0) continue;
    const participants = new Set(participantsRaw.map((x) => String(x)));
    for (const m of messages) {
      if (m.catId) participants.add(m.catId);
      for (const p of m.mentions) participants.add(p);
    }
    const md = toMarkdown(threadId, meta, participants, messages);
    const file = path.join(args.outDir, `thread-${threadId}.md`);
    exported += 1;
    if (!sameContent(file, md)) {
      updated += 1;
      if (!args.dryRun) fs.writeFileSync(file, md, 'utf8');
    }
  }

  console.log(`[thread-export] redis=${args.redisUrl}`);
  console.log(`[thread-export] outDir=${args.outDir}`);
  console.log(
    `[thread-export] threads=${threadIds.length} exported=${exported} updated=${updated} mode=${args.dryRun ? 'dry-run' : 'write'}`,
  );
  await redis.quit();
}

main().catch((err) => {
  console.error(`[thread-export] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
