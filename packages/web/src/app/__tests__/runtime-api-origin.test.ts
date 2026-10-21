// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeApiOriginFromPort } from '../../lib/runtime-api-origin';

vi.mock('@/components/AppShell', () => ({ AppShell: () => null }));
vi.mock('@/components/BrakeModal', () => ({ BrakeModal: () => null }));
vi.mock('@/components/CatHueInjector', () => ({ CatHueInjector: () => null }));
vi.mock('@/components/CoCreatorHueInjector', () => ({ CoCreatorHueInjector: () => null }));
vi.mock('@/components/GuideOverlay', () => ({ GuideOverlay: () => null }));
vi.mock('@/components/SessionBootstrap', () => ({ SessionBootstrap: () => null }));
vi.mock('@/components/ThemeApplier', () => ({ ThemeApplier: () => null }));
vi.mock('@/components/ThemeProvider', () => ({ ThemeProvider: () => null }));
vi.mock('@/components/ToastContainer', () => ({ ToastContainer: () => null }));
vi.mock('@/components/useConfirm', () => ({ ConfirmProvider: () => null }));

afterEach(() => vi.unstubAllEnvs());

describe('document runtime API identity', () => {
  it.each([
    undefined,
    '',
    '0',
    '-1',
    '65536',
    '3196/api',
    '3e3',
    ' 3196',
    '<script>',
  ])('omits an origin for a missing or invalid runtime port %s', (port) => {
    expect(runtimeApiOriginFromPort(port)).toBeUndefined();
  });

  it('renders the explicit runtime API port per request, without a build-time default or other env', async () => {
    const { default: RootLayout, dynamic } = await import('../layout');
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://localhost:3004');
    vi.stubEnv('OPENAI_API_KEY', 'fixture-private-not-public');
    vi.stubEnv('API_SERVER_PORT', '3196');
    expect(dynamic).toBe('force-dynamic');
    expect(RootLayout({ children: null }).props['data-cat-cafe-api-origin']).toBe('http://localhost:3196');
    vi.stubEnv('API_SERVER_PORT', '4117');
    const element = RootLayout({ children: null });
    expect(element.type).toBe('html');
    expect(element.props['data-cat-cafe-api-origin']).toBe('http://localhost:4117');
    expect(JSON.stringify(element.props)).not.toContain('fixture-private-not-public');
    vi.stubEnv('API_SERVER_PORT', '');
    expect(RootLayout({ children: null }).props['data-cat-cafe-api-origin']).toBeUndefined();
  });
});
