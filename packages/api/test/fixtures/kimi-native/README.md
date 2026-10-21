# Kimi native MCP contract fixtures

These MIT-licensed Moonshot AI sources are pinned to the commits and upstream
paths in `manifest.json`. Sources remain text fixtures: the test adapter checks
their normalized SHA-256 and strips TypeScript without changing parsing,
configuration discovery, precedence, or path normalization logic. Keep LICENSE.

- 0.34.0: v2 MCP schema, v1/v2 config loaders, and v2 Git worktree discovery.
- 2.2.0: v2 MCP schema. This does not claim testing a 2.2 loader.
- Zod 4.3.6 and pathe 2.0.3 match the pinned native package requirements.

The adapter only maps import boundaries: `pathe` and `zod` use the pinned test
dependencies; v1's MCP schema import uses the equivalent 0.34 v2 MCP schema;
bootstrap requires an explicit fixture HOME; application error classes and the
v2 host filesystem receive minimal Node-backed adapters. The actual v2 Git
discovery source is executed. No loader is reconstructed in test code.

Tests operate only in temporary directories. They never start an MCP server,
model, application service, or production database. No runtime credential or
native history directory is read. LF normalization permits Windows checkout.
