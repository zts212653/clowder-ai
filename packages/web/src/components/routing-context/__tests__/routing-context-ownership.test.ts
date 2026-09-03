import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = process.cwd();
const COMPONENTS_ROOT = path.join(WEB_ROOT, 'src/components');
const API_ROOT = path.resolve(WEB_ROOT, '../api/src');

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const absolute = path.join(root, entry);
    if (statSync(absolute).isDirectory()) files.push(...sourceFiles(absolute));
    else if (/\.(ts|tsx)$/.test(entry)) files.push(absolute);
  }
  return files;
}

function source(relativePath: string): string {
  return readFileSync(path.join(WEB_ROOT, relativePath), 'utf8');
}

describe('F293 Phase B ownership guard', () => {
  it('mounts one canonical Team renderer through the shared F284/F307 owner shell', () => {
    const definitions = sourceFiles(COMPONENTS_ROOT)
      .filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`))
      .filter((file) => readFileSync(file, 'utf8').includes('export function TeamWorkspacePanel'))
      .map((file) => path.relative(WEB_ROOT, file).replaceAll(path.sep, '/'));
    expect(definitions).toEqual(['src/components/routing-context/TeamWorkspacePanel.tsx']);

    const f284 = source('src/components/WorkspacePanel.tsx');
    const f307 = source('src/components/workbench/F307OwnerSurfaceRenderer.tsx');
    expect(f284).toContain("workspaceMode === 'team'");
    expect(f284).toContain('workspaceOpenRequest={workspaceOpenRequest}');
    expect(f284).not.toContain('<TeamWorkspacePanel');
    expect(f307).toContain("surface.objectRef.id === 'mode:team'");
    expect(f307).toContain('<TeamWorkspacePanel');
  });

  it('keeps Settings ledger read-only and routes every writer to Team', () => {
    const settings = source('src/components/settings/SettingsContent.tsx');
    const ledger = source('src/components/routing-context/RoutingContextLedger.tsx');
    expect(settings).toContain('<RoutingContextLedger');
    expect(settings.indexOf("section === 'profiles'")).toBeLessThan(settings.indexOf('<OpenTeamWorkspaceButton />'));
    expect(settings).not.toMatch(/Routing(?:Signal|Preference)Controls/);
    expect(ledger).not.toMatch(/routing-context-client|markRoutingSignal|closeRoutingSignal|createRoutingPreference/);
    expect(ledger).not.toContain('<form');
  });

  it('deep-links ordinary mentions into the exact Team subject', () => {
    const markdown = source('src/components/MarkdownContent.tsx');
    expect(markdown).toContain("openTeamSubject({ type: 'cat', id: catId })");
    expect(markdown).toContain('在猫猫团队中查看');
  });

  it('keeps Team single-column through 420/508px panels and enables two columns only at 780px', () => {
    const layout = source('src/components/routing-context/TeamWorkspacePanel.module.css');
    expect(layout).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(layout).toContain('@container (min-width: 48.75rem)');
    expect(layout).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
  });

  it('keeps resolver/store construction out of routes and actual-send consumers', () => {
    const consumers = [
      'routes/routing-context.ts',
      'routes/callback-a2a-trigger.ts',
      'routes/callbacks.ts',
      'domains/cats/services/agents/routing/route-serial.ts',
      'domains/cats/services/agents/routing/route-parallel.ts',
    ].map((relativePath) => readFileSync(path.join(API_ROOT, relativePath), 'utf8'));
    const joined = consumers.join('\n');
    expect(joined).not.toMatch(
      /new (?:RoutingContextResolver|RedisRoutingSignalEventStore|RedisRoutingPreferenceStore)/,
    );
    expect(joined).not.toMatch(/\.alternatives(?:\[|\.|\s*=)/);

    const compositionRoot = readFileSync(path.join(API_ROOT, 'index.ts'), 'utf8');
    expect(compositionRoot.match(/const routingContextRuntime = redisClient/g)).toHaveLength(1);
    expect(compositionRoot).toContain('createRoutingContextRuntime({');
  });
});
