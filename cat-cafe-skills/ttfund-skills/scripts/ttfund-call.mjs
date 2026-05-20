#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const GATEWAY_URL = 'https://skills.tiantianfunds.com/ai-smart-skill-service/openapi/skill/invoke';

const SKILLS = {
  FUND_BASE_INFOS: { version: '1.2.0', name: '天天基金信息' },
  FUND_MANAGER_INFO: { version: '1.0.0', name: '天天基金经理信息' },
  FUND_CONDITION_SELECT: { version: '1.1.0', name: '天天条件选基' },
  FUND_HOLDING_INFO: { version: '1.0.0', name: '天天基金重仓股' },
  FUND_HUAAN_GOLD_INFO: { version: '1.0.0', name: '天天黄金行情' },
  FUND_TG_STRATEGY_INFO: { version: '1.0.0', name: '天天投顾策略' },
  FUND_INDEX_INFO: { version: '1.0.0', name: '天天指数行情' },
  FUND_NAV_INFO: { version: '1.0.0', name: '天天基金净值' },
  MODEL_PORTFOLIO: { version: '1.0.0', name: '天天模拟交易' },
  FUND_FAVOR_ZX: { version: '1.2.0', name: '天天自选管理' },
  BOND_MARKET: { version: '1.0.0', name: '天天债市行情' },
  FUND_GROUP_BACKTEST: { version: '1.0.0', name: '天天组合回测' },
  FUND_SEARCH: { version: '1.0.0', name: '天天基金搜索' },
  FUND_STOCK_PRICE_QUERY: { version: '1.0.0', name: '天天股票股价查询' },
  FUND_THEME_INFO: { version: '1.0.0', name: '天天基金主题skill' },
  FUND_HUOQIBAO_LIST: { version: '1.0.0', name: '天天活期宝' },
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../..');

function loadDotEnvFile(path) {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    const value = rawValue.replace(/^['"]|['"]$/g, '');
    process.env[key] = value;
  }
}

function loadLocalEnv() {
  loadDotEnvFile(resolve(repoRoot, '.env'));
  loadDotEnvFile(resolve(repoRoot, '.env'));
}

function printUsage() {
  console.error(`Usage:
  node cat-cafe-skills/ttfund-skills/scripts/ttfund-call.mjs list
  node cat-cafe-skills/ttfund-skills/scripts/ttfund-call.mjs <SKILL_ID> '<JSON_PAYLOAD>'

Example:
  node cat-cafe-skills/ttfund-skills/scripts/ttfund-call.mjs FUND_SEARCH '{"query":"沪深300","search_type":"fund","page_index":1,"page_size":5}'
`);
}

function listSkills() {
  for (const [skillId, meta] of Object.entries(SKILLS)) {
    console.log(`${skillId}\t${meta.version}\t${meta.name}`);
  }
}

function parsePayload(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON payload: ${error.message}`);
  }
}

async function invoke(skillId, rawPayload) {
  const meta = SKILLS[skillId];
  if (!meta) {
    throw new Error(`Unknown skill_id: ${skillId}. Run "list" to see supported IDs.`);
  }

  loadLocalEnv();
  const apiKey = process.env.TTFUND_APIKEY;
  if (!apiKey) {
    throw new Error(
      'Missing TTFUND_APIKEY. Open 天天基金 App, search "skills", copy the key, then set it in env or .env.',
    );
  }

  const payload = {
    ...parsePayload(rawPayload),
    skill_id: skillId,
    _skill_version: parsePayload(rawPayload)._skill_version ?? meta.version,
  };

  const response = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`TTFund gateway HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
}

async function main() {
  const [command, payload] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  if (command === 'list') {
    listSkills();
    return;
  }

  await invoke(command, payload);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
