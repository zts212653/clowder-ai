import assert from 'node:assert/strict';
import test from 'node:test';

import { helpersScript, installScript } from './windows-portable-redis-test-helpers.js';

test('Windows installer carries selected CLI commands into auth setup when command shims are not yet visible', () => {
  assert.match(installScript, /\$selectedCliCommands = @\(\$toolsToInstall \| ForEach-Object \{ \$_.Cmd \}\)/);
  assert.match(
    installScript,
    /Configure-InstallerAuth -ProjectRoot \$ProjectRoot -State \$authState -SelectedCliCommands \$selectedCliCommands/,
  );
  assert.match(
    helpersScript,
    /function Configure-InstallerAuth \{\s+param\(\[string\]\$ProjectRoot, \$State, \[string\[\]\]\$SelectedCliCommands = @\(\)\)/s,
  );
  assert.match(helpersScript, /\$shouldOfferClaude = \$hasClaude -or \(\$SelectedCliCommands -contains "claude"\)/);
  assert.match(helpersScript, /\$shouldOfferCodex = \$hasCodex -or \(\$SelectedCliCommands -contains "codex"\)/);
  assert.match(helpersScript, /\$shouldOfferGemini = \$hasGemini -or \(\$SelectedCliCommands -contains "gemini"\)/);
  assert.match(helpersScript, /\$shouldOfferKimi = \$hasKimi -or \(\$SelectedCliCommands -contains "kimi"\)/);
  assert.match(helpersScript, /if \(\$shouldOfferClaude\) \{/);
  assert.match(helpersScript, /if \(\$shouldOfferCodex\) \{/);
  assert.match(helpersScript, /if \(\$shouldOfferGemini\) \{/);
  assert.match(helpersScript, /if \(\$shouldOfferKimi\) \{/);
});
