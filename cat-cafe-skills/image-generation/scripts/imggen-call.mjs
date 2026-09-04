#!/usr/bin/env node
// OpenAI 兼容图像网关出图：prompt 从 stdin 读，图片落到 uploadDir，打印 /uploads/ 相对路径。
// 用法：node imggen-call.mjs [--model <name>] [--size 1024x1024] [--upload-dir <abs>] <<'PROMPT' ... PROMPT

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const TIMEOUT_MS = 300_000; // 实测单张 ~100s、响应 >1.5MB，120s 会在下载途中被掐断
const DEFAULT_MODEL = 'gpt-image-2';
const DEFAULT_SIZE = '1024x1024';

function fail(what, why, how) {
  console.error(`imggen 失败：${what}\n原因：${why}\n修复：${how}`);
  process.exit(1);
}

if (process.argv.includes('--help')) {
  console.log(
    [
      '用法：node imggen-call.mjs [选项] <<\'PROMPT\' ... PROMPT',
      '',
      '  --model <name>       默认 gpt-image-2；含中文文字必选 gpt-image-2（Google 系中文乱码）',
      '  --size <WxH>         默认 1024x1024',
      '  --upload-dir <path>  绝对路径，覆盖 UPLOAD_DIR；必须是当前 API 正在服务的那一份 uploads/',
      '',
      '环境变量（由部署者通过账号 envVars 注入，脚本不含任何硬编码凭据）：',
      '  IMAGE_GATEWAY_BASE_URL   OpenAI 兼容网关根，需含 /v1，例 https://host/v1',
      '  IMAGE_GATEWAY_API_KEY    该网关的 key；key 所属分组决定可用模型',
      '  UPLOAD_DIR               /uploads/ 静态服务的根目录（绝对路径）',
    ].join('\n'),
  );
  process.exit(0);
}

function readFlag(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const baseUrl = process.env.IMAGE_GATEWAY_BASE_URL?.replace(/\/+$/, '');
if (!baseUrl) {
  fail(
    'API 网关路径不可用',
    '未注入 IMAGE_GATEWAY_BASE_URL',
    '向 operator 报告网关未配置（账号 envVars），不要猜地址；或改走原生/浏览器路径',
  );
}
if (!process.env.IMAGE_GATEWAY_API_KEY) {
  fail(
    'API 网关路径不可用',
    '未注入 IMAGE_GATEWAY_API_KEY',
    '向 operator 报告网关 key 未配置（账号 envVars），不要猜 key',
  );
}

const uploadDir = readFlag('--upload-dir') ?? process.env.UPLOAD_DIR;
if (!uploadDir) {
  fail(
    '无法确定落盘目录',
    '未注入 UPLOAD_DIR，且未传 --upload-dir',
    '传当前 API 正在服务的 uploads/ 绝对路径（默认为 <运行时>/packages/api/uploads）；不要用 worktree 内的副本，否则气泡里会裂图',
  );
}
if (!isAbsolute(uploadDir)) {
  fail(
    '落盘目录不合法',
    `UPLOAD_DIR/--upload-dir 必须是绝对路径，收到 "${uploadDir}"`,
    '相对路径按当前 cwd 解析，会写到 API 没在服务的目录；改传绝对路径',
  );
}

const prompt = await new Promise((res, rej) => {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
  });
  process.stdin.on('end', () => res(buf.trim()));
  process.stdin.on('error', rej);
});
if (!prompt) {
  fail('没有 prompt', 'stdin 为空', "用 heredoc 传入：node imggen-call.mjs <<'PROMPT' ... PROMPT");
}

const model = readFlag('--model') ?? DEFAULT_MODEL;
const size = readFlag('--size') ?? DEFAULT_SIZE;
const endpoint = `${baseUrl}/images/generations`;

let payload;
try {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.IMAGE_GATEWAY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, prompt, n: 1, size }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  try {
    payload = JSON.parse(text);
  } catch {
    fail(
      `网关返回非 JSON（${endpoint}, HTTP ${res.status}）`,
      text.slice(0, 300),
      'HTTP 404 通常是 IMAGE_GATEWAY_BASE_URL 少了 /v1；其他状态码把原文报给 operator',
    );
  }
} catch (err) {
  const why = err?.name === 'TimeoutError' ? `超过 ${TIMEOUT_MS / 1000}s 未返回` : String(err?.message ?? err);
  fail(`请求网关失败（${endpoint}）`, why, '确认网关可达与 base URL 正确后重试一次；连续失败报给 operator，不要循环硬闯');
}

if (payload.error) {
  const msg = payload.error.message ?? JSON.stringify(payload.error);
  fail(
    `模型 ${model} 出图被网关拒绝`,
    msg,
    `model_not_found 表示这把 key 的分组没有该渠道：先 GET ${baseUrl}/models 核对逐字模型名，换模型或换 key 分组；不要重试硬闯（clowder-ai#1236）`,
  );
}

const b64 = payload.data?.[0]?.b64_json;
if (!b64) {
  fail(
    `模型 ${model} 未返回图片数据`,
    `响应缺少 data[0].b64_json，顶层字段：${Object.keys(payload).join(', ') || '(空)'}`,
    '确认该模型走 b64 返回；若网关只给 url，把响应结构报给 operator',
  );
}

// 幂等 stem：同一 prompt+model+size 重复出图复用同一文件，对齐 F172 buildPublicationStem 的 sha256 前 8 位约定
const stem = `imggen-${model}-${createHash('sha256').update(`${model}|${size}|${prompt}`).digest('hex').slice(0, 8)}`.replace(
  /[^a-zA-Z0-9._-]/g,
  '-',
);
const bytes = Buffer.from(b64, 'base64');
await mkdir(uploadDir, { recursive: true });
await writeFile(join(resolve(uploadDir), `${stem}.png`), bytes);
console.log(`/uploads/${stem}.png ${bytes.length} bytes`);
