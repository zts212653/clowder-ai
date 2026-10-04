import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MANAGED_COMMAND_TERMINAL_DECLARATION_KEY,
  readDeclaredManagedTerminalState,
} from '../dist/domains/ball-custody/managed-command-terminal-declaration.js';
import { buildManagedCommandWakeContent } from '../dist/routes/callback-hold-ball-routes.js';

const GATE_SCRIPT = fileURLToPath(new URL('../../../scripts/pre-merge-check.sh', import.meta.url));
const DECLARATION = `${MANAGED_COMMAND_TERMINAL_DECLARATION_KEY}=unverified`;

function wake(result) {
  return buildManagedCommandWakeContent(
    { timedOut: false, durationMs: 1000, tailOutput: '', ...result },
    'reason',
    'pnpm gate',
    'next step',
  );
}

describe('managed command declared terminal state', () => {
  it('never reinterprets a zero exit, whatever the command printed', () => {
    assert.equal(readDeclaredManagedTerminalState(DECLARATION, 0), null);
    assert.match(wake({ exitCode: 0, tailOutput: DECLARATION }), /✅ 成功/u);
  });

  it('ignores a declaration this renderer does not know', () => {
    assert.equal(
      readDeclaredManagedTerminalState(`${MANAGED_COMMAND_TERMINAL_DECLARATION_KEY}=probably_fine`, 3),
      null,
    );
    assert.match(wake({ exitCode: 3, tailOutput: `${MANAGED_COMMAND_TERMINAL_DECLARATION_KEY}=probably_fine` }), /❌/u);
  });

  it('leaves an undeclared failure rendered as an ordinary failure', () => {
    assert.equal(readDeclaredManagedTerminalState('some build error', 1), null);
    const content = wake({ exitCode: 1, tailOutput: 'some build error' });
    assert.match(content, /❌ 退出码 1/u);
    assert.doesNotMatch(content, /未验证/u);
  });

  it('ignores a declaration that something kept running past', () => {
    // A chained managed command can classify, declare, and then genuinely fail.
    // Honouring an earlier marker would file that failure as merely unverified.
    const tailOutput = ['classified', DECLARATION, 'real cleanup failure'].join('\n');

    assert.equal(readDeclaredManagedTerminalState(tailOutput, 1), null);
    const content = wake({ exitCode: 1, tailOutput });
    assert.match(content, /❌ 退出码 1/u);
    assert.doesNotMatch(content, /未验证/u);
  });

  it('accepts a declaration that trailing blank lines follow', () => {
    const tailOutput = `${DECLARATION}\n\n`;
    assert.equal(readDeclaredManagedTerminalState(tailOutput, 3), 'unverified');
  });

  it('renders a declared unverified terminal as neither passed nor failed', () => {
    const tailOutput = [
      '⚠ UNVERIFIED — gate classification finished; this route carries no verification evidence.',
      '   Still owed at this exact HEAD: cross-package-typecheck, targeted-checks',
      DECLARATION,
    ].join('\n');

    assert.equal(readDeclaredManagedTerminalState(tailOutput, 3), 'unverified');
    const content = wake({ exitCode: 3, tailOutput });

    assert.doesNotMatch(content, /✅ 成功/u, 'an unverified terminal must never read as a pass');
    assert.doesNotMatch(content, /^结果：❌/mu, 'an unverified terminal must not be filed as an ordinary failure');
    assert.match(content, /未验证/u);
    // The owner must still receive what is actually owed, not only a label.
    assert.match(content, /cross-package-typecheck, targeted-checks/u);
  });

  it('keeps the shell and API sides of the declaration key identical', () => {
    const script = readFileSync(GATE_SCRIPT, 'utf8');
    assert.match(
      script,
      new RegExp(`GATE_MANAGED_TERMINAL_DECLARATION_KEY="${MANAGED_COMMAND_TERMINAL_DECLARATION_KEY}"`, 'u'),
      'the gate must declare the exact key the wake renderer reads',
    );
  });
});
