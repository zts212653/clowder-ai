import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveAcpBootstrapRoot } from '../../src/domains/cats/services/agents/providers/acp/acp-bootstrap-cwd.ts';
import { inspectAcpBootstrapDirectory } from '../../src/domains/cats/services/agents/providers/acp/bootstrap/acp-bootstrap-inspect.ts';

test(
  'an explicitly selected default-named root must not silently relocate',
  { skip: process.platform !== 'win32' },
  () => {
    const parent = mkdtempSync(join(tmpdir(), 'acp-explicit-default-'));
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, ProgramData: process.env.ProgramData };
    try {
      const script = `$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd();
      [IO.Directory]::CreateDirectory($p+'\\unsafe') | Out-Null;
      $acl=[IO.Directory]::GetAccessControl($p+'\\unsafe');
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-11'),'Delete','Allow'));
      [IO.Directory]::SetAccessControl($p+'\\unsafe',$acl)`;
      execFileSync(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { input: parent, windowsHide: true },
      );
      process.env.TEMP = join(parent, 'unsafe');
      process.env.TMP = process.env.TEMP;
      process.env.ProgramData = parent;
      const result = inspectAcpBootstrapDirectory(resolveAcpBootstrapRoot());
      assert.equal(result.ok, false, 'explicit selection cannot choose a safe but different ProgramData root');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      assert.match(parent, /acp-explicit-default-[^\\/]+$/);
      rmSync(parent, { recursive: true });
    }
  },
);
