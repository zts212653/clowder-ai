// #1566: managed edits are spliced into the original text. Third-party bytes (number lexemes,
// escapes, formatting) never change, so values the CLI hashes for trust stay identical.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { getAgentHookStatus, syncAgentHooks } from '../dist/agent-hooks/index.js';

const bashCmd = (scriptPath) => `bash "${scriptPath}"`;

/** Length of the common prefix and suffix; the changed region is original[prefix, length - suffix). */
function changedRegion(original, after) {
  let prefix = 0;
  while (prefix < original.length && original[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < original.length - prefix &&
    original[original.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  return { start: prefix, end: original.length - suffix };
}

describe('#1566 hook config source fidelity', () => {
  let projectRoot;
  let targetRoot;
  let start;
  let stop;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'hook-fidelity-project-'));
    const hookDir = join(projectRoot, '.claude', 'hooks', 'user-level');
    await mkdir(hookDir, { recursive: true });
    await writeFile(join(hookDir, 'session-start-recall.sh'), '#!/bin/bash\necho start\n', 'utf8');
    await writeFile(join(hookDir, 'session-stop-check.sh'), '#!/bin/bash\necho stop\n', 'utf8');
    targetRoot = await mkdtemp(join(tmpdir(), 'hook-fidelity-home-'));
    start = bashCmd(join(targetRoot, '.claude', 'hooks', 'session-start-recall.sh'));
    stop = bashCmd(join(targetRoot, '.claude', 'hooks', 'session-stop-check.sh'));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  });

  async function syncText(file, text) {
    const path = join(targetRoot, file);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text, 'utf8');
    await syncAgentHooks({ projectRoot, targetRoot });
    return readFile(path, 'utf8');
  }

  async function health(name) {
    return (await getAgentHookStatus({ projectRoot, targetRoot })).targets.find((target) => target.name === name);
  }

  const quirkyCodex = (stopEntry) =>
    [
      '{',
      '    "description":"caf\\u00e9 hooks",',
      '    "hooks": {',
      `        "SessionStart": [ {"hooks":[{"type":"command","command":${JSON.stringify(start)}}]} ],`,
      '        "PreToolUse": [',
      '            {"matcher":"Bash","hooks":[{"type":"mcp_tool","server":"s","tool":"t",',
      '              "input":{"big":9007199254740993,"float":1.0,"exp":1e0,"neg":-0}, "timeout": 30}]}',
      `        ]${stopEntry}`,
      '    }',
      '}',
      '',
    ].join('\r\n');

  it('adds missing managed entries as a pure insertion: every original byte is kept', async () => {
    const original = quirkyCodex('');
    const after = await syncText('.codex/hooks.json', original);
    const region = changedRegion(original, after);
    assert.equal(region.start, region.end, 'nothing of the original is removed or rewritten');
    const inserted = after.slice(region.start, after.length - (original.length - region.end));
    assert.match(inserted, /^,\r\n {8}"Stop": /, 'inserted member follows the file layout');
    assert.deepEqual(JSON.parse(after).hooks.Stop, [{ hooks: [{ type: 'command', command: `${stop} --codex-json` }] }]);
    assert.equal((await health('codex-hooks'))?.status, 'configured');
  });

  it('rewrites only the outdated managed command literal', async () => {
    const original = quirkyCodex(
      `,\r\n        "Stop": [{"hooks":[{"type":"command","command":${JSON.stringify(stop)}}]}]`,
    );
    const after = await syncText('.codex/hooks.json', original);
    const literal = original.indexOf(JSON.stringify(stop));
    const region = changedRegion(original, after);
    assert.ok(region.start >= literal && region.end <= literal + JSON.stringify(stop).length, 'edit stays in literal');
    assert.equal(JSON.parse(after).hooks.Stop[0].hooks[0].command, `${stop} --codex-json`);
  });

  it('removes duplicate Claude entries without touching other bytes', async () => {
    const original = [
      '{ "env": {"RATIO": 1.50},',
      '  "hooks": {',
      `    "SessionStart": [ {"hooks": [{"type":"command","command":${JSON.stringify(start)}}]},`,
      '                      {"matcher": "*", "hooks": [{"type":"command","command":"echo keep","timeout":2.50}]},',
      `                      {"hooks": [{"type":"command","command":${JSON.stringify(start)}}]} ],`,
      `    "Stop": [{"hooks": [{"type":"command","command":${JSON.stringify(stop)}}]}] } }`,
    ].join('\n');
    const after = await syncText('.claude/settings.json', original);
    for (const raw of [
      '"RATIO": 1.50',
      '{"matcher": "*", "hooks": [{"type":"command","command":"echo keep","timeout":2.50}]}',
    ]) {
      assert.ok(after.includes(raw), `kept verbatim: ${raw}`);
    }
    const { hooks } = JSON.parse(after);
    assert.equal(hooks.SessionStart.length, 2);
    assert.equal((await health('claude-settings'))?.status, 'configured');
  });

  it('refuses duplicate keys, aliases and non-integer lexemes the CLI would read differently', async () => {
    const managed = `"SessionStart":[{"hooks":[{"type":"command","command":${JSON.stringify(start)}}]}]`;
    const handler = (fields) =>
      `{${managed},"PreToolUse":[{"hooks":[{"type":"command","command":"echo t"${fields}}]}]}`;
    const cases = [
      [`{"hooks":{${managed}},"hooks":{${managed}}}`, /duplicate key "hooks"/],
      [`{"hooks":${handler(',"command":"echo again"')}}`, /duplicate key "command"/],
      [`{"hooks":${handler(',"commandWindows":"a","command_windows":"b"')}}`, /same field/],
      [`{"hooks":${handler(',"commandWindows":null,"command_windows":"b"')}}`, /same field/],
      [`{"hooks":${handler(',"timeout":5.0')}}`, /timeout/],
      [`{"hooks":${handler(',"timeout":5e0')}}`, /timeout/],
      // One above i64::MAX panics Codex 0.159.3 hook discovery (TOML trust hash).
      [`{"hooks":${handler(',"timeout":9223372036854775808')}}`, /timeout/],
      [
        `{"hooks":{${managed},"PreToolUse":[{"hooks":[{"type":"mcp_tool","server":"s","tool":"t","input":{"n":[1,null]}}]}]}}`,
        /TOML/,
      ],
    ];
    for (const [text, reason] of cases) {
      const after = await syncText('.codex/hooks.json', text);
      assert.equal(after, text, `left untouched: ${text.slice(0, 120)}`);
      const result = await health('codex-hooks');
      assert.equal(result?.status, 'error');
      assert.match(result?.reason ?? '', reason);
    }
    const accepted = [
      ',"commandWindows":"a"',
      ',"command_windows":"b"',
      ',"timeout":9223372036854775807',
      ',"timeout":-0',
      ',"type2":0,"timeout":null',
    ];
    for (const fields of accepted) {
      const after = await syncText('.codex/hooks.json', `{"hooks":${handler(fields)}}`);
      assert.equal(JSON.parse(after).hooks.Stop.length, 1, `accepted and merged: ${fields}`);
    }
    // Codex accepts any JSON number in mcp_tool input (verified natively); keep it verbatim.
    const input = '"input":{"n":10000000000000000000,"inf":1e400}';
    const merged = await syncText(
      '.codex/hooks.json',
      `{"hooks":{${managed},"PreToolUse":[{"hooks":[{"type":"mcp_tool","server":"s","tool":"t",${input}}]}]}}`,
    );
    assert.ok(merged.includes(input), 'large input numbers kept verbatim');
    assert.equal((await health('codex-hooks'))?.status, 'configured');
  });

  it('classifies prototype-named handler types instead of throwing', async () => {
    for (const type of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      const third = `{"PreToolUse":[{"hooks":[{"type":${JSON.stringify(type)},"command":"echo t","prompt":"p"}]}]`;
      const managed = `"SessionStart":[{"hooks":[{"type":"command","command":${JSON.stringify(start)}}]}]`;
      const text = `{"hooks":${third},${managed}}}`;
      for (const [file, name, status] of [
        ['.codex/hooks.json', 'codex-hooks', 'error'],
        ['.claude/settings.json', 'claude-settings', 'error'],
        ['.gemini/hooks.json', 'gemini-hooks', 'configured'],
      ]) {
        await syncText(file, text);
        assert.equal((await health(name))?.status, status, `${name} classifies type ${type}`);
      }
    }
  });
});
