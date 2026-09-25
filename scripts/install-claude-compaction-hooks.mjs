#!/usr/bin/env node
// Explicit installer/repair entry point. Preview by default; --apply writes settings.
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function isManagedCommand(command, phase, legacy) {
  if (typeof command !== 'string') return false;
  const trimmed = command.trim();
  if (trimmed === legacy) return true;
  // The script/phase identify the managed hook across Node runtime upgrades.
  const match = trimmed.match(
    /^(?:"[^"\r\n]*[\\/]node(?:\.exe)?"|node) "\.claude\/hooks\/f24-compaction\.mjs" (pre|post)$/,
  );
  return match?.[1] === phase;
}

export function installClaudeCompactionHooks({ sourceRoot, projectRoot, apply = false }) {
  const settingsPath = join(projectRoot, '.claude', 'settings.json');
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid project settings');
  if (settings.disableAllHooks === true) throw new Error('Project explicitly disables hooks');
  const localPath = join(projectRoot, '.claude', 'settings.local.json');
  if (existsSync(localPath) && JSON.parse(readFileSync(localPath, 'utf8')).disableAllHooks === true) {
    throw new Error('Project local settings explicitly disable hooks');
  }
  if (
    settings.hooks !== undefined &&
    (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))
  ) {
    throw new Error('Invalid project hooks');
  }
  settings.hooks ??= {};
  for (const [event, matcher, phase] of [
    ['PreCompact', 'manual|auto', 'pre'],
    ['SessionStart', 'compact', 'post'],
  ]) {
    const entries = settings.hooks[event] ?? [];
    if (!Array.isArray(entries)) throw new Error(`Invalid ${event} hook entries`);
    const legacy =
      event === 'PreCompact'
        ? '"$CLAUDE_PROJECT_DIR"/.claude/hooks/f24-pre-compact.sh'
        : '"$CLAUDE_PROJECT_DIR"/.claude/hooks/f24-post-compact-bootstrap.sh';
    const command = `"${process.execPath.replaceAll('\\', '/')}" ".claude/hooks/f24-compaction.mjs" ${phase}`;
    // Replace only exact managed commands. Custom hooks keep their order/content.
    settings.hooks[event] = entries
      .map((entry) => {
        if (!Array.isArray(entry.hooks)) throw new Error(`Invalid ${event} hook entry`);
        return { ...entry, hooks: entry.hooks.filter((hook) => !isManagedCommand(hook.command, phase, legacy)) };
      })
      .filter((entry) => entry.hooks.length > 0);
    settings.hooks[event].push({ matcher, hooks: [{ type: 'command', command, timeout: 15 }] });
  }
  const source = join(sourceRoot, '.claude', 'hooks', 'f24-compaction.mjs');
  if (!existsSync(source)) throw new Error(`Missing packaged hook: ${source}`);
  const destination = join(projectRoot, '.claude', 'hooks', 'f24-compaction.mjs');
  if (apply) {
    mkdirSync(dirname(destination), { recursive: true });
    if (!existsSync(destination) || realpathSync(source) !== realpathSync(destination))
      copyFileSync(source, destination);
    const rendered = `${JSON.stringify(settings, null, 2)}\n`;
    const previous = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : undefined;
    if (previous !== rendered) {
      if (previous !== undefined)
        writeFileSync(`${settingsPath}.before-compaction-${Date.now()}.bak`, previous, { flag: 'wx' });
      writeFileSync(settingsPath, rendered);
    }
  }
  return { applied: apply, settingsPath, hookPath: destination, hooks: settings.hooks };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const value = (name) => {
      const index = args.indexOf(name);
      return index < 0 ? undefined : args[index + 1];
    };
    const sourceRoot = resolve(value('--source-root') ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
    const projectRoot = value('--project-root');
    if (!projectRoot) throw new Error('--project-root is required');
    console.log(
      JSON.stringify(
        installClaudeCompactionHooks({
          sourceRoot,
          projectRoot: resolve(projectRoot),
          apply: args.includes('--apply'),
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
