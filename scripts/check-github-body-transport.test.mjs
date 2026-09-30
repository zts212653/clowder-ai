import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = resolve(process.cwd());
const SYNC_SCRIPT_PATH = resolve(ROOT, 'scripts/sync-to-opensource.sh');
const isHomeRepo = existsSync(SYNC_SCRIPT_PATH);
const guides = [
  { delimiter: 'CLAUDE_EOF', file: 'CLAUDE.md' },
  { delimiter: 'AGENTS_EOF', file: 'AGENTS.md' },
  { delimiter: 'GEMINI_EOF', file: 'GEMINI.md' },
];

function readSyncScript() {
  return readFileSync(SYNC_SCRIPT_PATH, 'utf8');
}

function githubBodyTransportSection() {
  const match = readSyncScript().match(
    /GITHUB_BODY_TRANSPORT_SECTION=\$\(cat <<'GITHUB_BODY_TRANSPORT_EOF'\n([\s\S]*?)\nGITHUB_BODY_TRANSPORT_EOF\n\)/,
  );
  assert.ok(match, 'sync-to-opensource.sh must own one GitHub body transport fragment');
  return match[1];
}

function generatedGuide({ delimiter, file }) {
  const content = readSyncScript();
  const guidePattern = new RegExp(
    `cat > "\\$FILTERED_DIR/${file.replace('.', '\\.')}" << '${delimiter}'\\n([\\s\\S]*?)\\n${delimiter}`,
  );
  const match = content.match(guidePattern);
  assert.ok(match, `sync-to-opensource.sh must generate public ${file}`);

  const appendLine = `printf '\\n%s\\n' "$GITHUB_BODY_TRANSPORT_SECTION" >> "$FILTERED_DIR/${file}"`;
  assert.equal(
    content.split(appendLine).length - 1,
    1,
    `${file} must append the canonical GitHub body transport fragment exactly once`,
  );
  return `${match[1]}\n\n${githubBodyTransportSection()}\n`;
}

describe(
  'Generated public agent-guide GitHub body transport contract',
  { skip: !isHomeRepo && 'sync infrastructure not present (open-source repo)' },
  () => {
    it('appends exactly one identical contract to CLAUDE.md, AGENTS.md, and GEMINI.md', () => {
      const renderedGuides = guides.map(generatedGuide);
      const sections = renderedGuides.map((guide) => {
        assert.equal((guide.match(/^## GitHub Body Transport$/gm) ?? []).length, 1);
        return guide.slice(guide.indexOf('## GitHub Body Transport')).trimEnd();
      });
      assert.deepEqual(sections, [sections[0], sections[0], sections[0]]);

      const contract = sections[0];
      assert.match(contract, /UTF-8 file without BOM/);
      assert.match(contract, /--body-file <path>/);
      assert.match(contract, /gh api \.\.\. --input <path>/);
      assert.match(contract, /\$body -is \[string\]/);
      assert.match(contract, /@\{ body = \[string\]\$body \} \| ConvertTo-Json/);
      assert.match(contract, /\[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
      assert.match(contract, /read the remote body back through the GitHub API/);
      assert.match(contract, /edit the original object in place/);
      assert.match(contract, /do not create a duplicate comment/);
    });

    it('preserves CJK Markdown bytes and string type through a UTF-8 JSON request fixture', () => {
      const dir = mkdtempSync(resolve(tmpdir(), 'github-body-transport-'));
      try {
        const bodyPath = resolve(dir, 'body.md');
        const jsonPath = resolve(dir, 'request.json');
        const expected = '# 中文标题\n\n正文保留 `backticks`。\n\n- 第一行\n- second line\n';

        writeFileSync(bodyPath, expected, { encoding: 'utf8' });
        const bodyBytes = readFileSync(bodyPath);
        assert.notDeepEqual([...bodyBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);

        const body = readFileSync(bodyPath, 'utf8');
        assert.equal(body, expected);
        writeFileSync(jsonPath, JSON.stringify({ body }), { encoding: 'utf8' });

        const jsonBytes = readFileSync(jsonPath);
        assert.notDeepEqual([...jsonBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
        const request = JSON.parse(jsonBytes.toString('utf8'));
        assert.equal(typeof request.body, 'string');
        assert.equal(request.body, expected);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('exposes BOM pollution instead of treating the decoded body as an exact match', () => {
      const dir = mkdtempSync(resolve(tmpdir(), 'github-body-transport-bom-'));
      try {
        const bodyPath = resolve(dir, 'body-with-bom.md');
        const expected = '中文正文 with `Markdown`\nsecond line\n';
        writeFileSync(bodyPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(expected, 'utf8')]));

        const decoded = readFileSync(bodyPath, 'utf8');
        assert.equal(decoded.codePointAt(0), 0xfeff);
        assert.notEqual(decoded, expected);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects the string-array shape produced by line-oriented PowerShell reads', () => {
      const request = { body: ['中文正文', '`Markdown`', 'second line'] };
      assert.notEqual(typeof request.body, 'string');
    });

    it(
      'executes the documented PowerShell recipe when run on Windows with powershell.exe',
      { skip: process.platform !== 'win32' && 'requires Windows powershell.exe; not executed on this platform' },
      () => {
        const dir = mkdtempSync(resolve(tmpdir(), 'github-body-transport-powershell-'));
        try {
          const bodyPath = resolve(dir, 'body.md');
          const jsonPath = resolve(dir, 'request.json');
          const scriptPath = resolve(dir, 'round-trip.ps1');
          const expected = '# 中文标题\n\n正文保留 `backticks`。\n\nsecond line\n';
          const script = [
            'param([string]$BodyPath, [string]$JsonPath)',
            '$body = [System.IO.File]::ReadAllText($BodyPath, [System.Text.Encoding]::UTF8)',
            "if (-not ($body -is [string])) { throw 'body must be a string' }",
            '$json = @{ body = [string]$body } | ConvertTo-Json',
            '[System.IO.File]::WriteAllText($JsonPath, $json, [System.Text.UTF8Encoding]::new($false))',
          ].join('\r\n');

          writeFileSync(bodyPath, expected, { encoding: 'utf8' });
          writeFileSync(scriptPath, script, { encoding: 'ascii' });
          execFileSync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, bodyPath, jsonPath],
            { stdio: 'pipe' },
          );

          const jsonBytes = readFileSync(jsonPath);
          assert.notDeepEqual([...jsonBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
          const request = JSON.parse(jsonBytes.toString('utf8'));
          assert.equal(typeof request.body, 'string');
          assert.equal(request.body, expected);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  },
);
