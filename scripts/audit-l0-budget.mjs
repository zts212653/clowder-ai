#!/usr/bin/env node
// Read-only diagnostic: stdout contains counts only, never prompts or catalog bytes.
import { Console } from 'node:console';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--config-root');
if (rootIndex < 0 || !args[rootIndex + 1] || args[rootIndex + 1].startsWith('--')) {
  process.stderr.write(
    'Usage: node scripts/audit-l0-budget.mjs --config-root <project-root> [--user <id>] [--empty-profile]\n',
  );
  process.exit(2);
}
const root = resolve(args[rootIndex + 1]);
const userIndex = args.indexOf('--user');
const userId = userIndex >= 0 ? args[userIndex + 1] : 'default-user';
if (!userId || userId.startsWith('--')) {
  process.stderr.write('Missing user ID\n');
  process.exit(2);
}
process.env.CAT_CAFE_CONFIG_ROOT = root;
process.env.CAT_TEMPLATE_PATH = join(root, 'cat-template.json');
const diagnosticConsole = new Console({ stdout: process.stderr, stderr: process.stderr });
for (const method of ['log', 'info', 'warn', 'error', 'debug'])
  console[method] = diagnosticConsole[method].bind(diagnosticConsole);
let emptyProfile;
try {
  const { catRegistry } = await import('@cat-cafe/shared');
  const { loadResolvedCatConfig, toAllCatConfigs } = await import('../packages/api/dist/config/cat-config-loader.js');
  const { auditL0Budget } = await import('../packages/api/dist/domains/cats/services/context/l0-budget-audit.js');
  const config = loadResolvedCatConfig(process.env.CAT_TEMPLATE_PATH, { persistMigrations: false });
  for (const [id, member] of Object.entries(toAllCatConfigs(config))) catRegistry.register(id, member);
  if (args.includes('--empty-profile')) emptyProfile = mkdtempSync(join(tmpdir(), 'cat-cafe-l0-empty-profile-'));
  const audit = await auditL0Budget({ projectRoot: root, userId, profileDir: emptyProfile, compilerCwd: root });
  process.stdout.write(
    `${JSON.stringify(
      {
        configRoot: root,
        memberCount: audit.members.length,
        ...audit,
        profile: emptyProfile ? 'empty' : audit.profile,
      },
      null,
      2,
    )}\n`,
  );
} catch {
  process.stderr.write('L0 budget audit unavailable; verify the config root and build the API.\n');
  process.exitCode = 1;
} finally {
  if (emptyProfile) rmSync(emptyProfile, { recursive: true, force: true });
}
