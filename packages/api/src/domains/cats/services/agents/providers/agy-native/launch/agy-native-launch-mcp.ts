import { join } from 'node:path';
import { pluginMcpEnvironment } from '../../../../../../../config/capabilities/plugin-mcp-environment.js';
import { findMonorepoRoot } from '../../../../../../../utils/monorepo-root.js';
import { resolveProviderMcpConfig } from '../../provider-mcp-config.js';
import { prepareAgyNativeCredentialFile } from '../agy-native-credential-file.js';
import type { AgyNativeLaunchInput } from '../agy-native-launch.js';
import { materializeAgyNativeMcpConfig } from '../agy-native-mcp-config.js';

/** Issued member servers and ordinary capability discovery never share a run configuration. */
export async function materializeAgyLaunchMcp(
  home: string,
  input: AgyNativeLaunchInput,
  callbackEnv?: Readonly<Record<string, string>>,
): Promise<(() => void) | undefined> {
  const runtimeRoot = findMonorepoRoot(process.cwd());
  const member = input.options?.pluginNativeLaunch;
  if (member) {
    await member.assertCurrent();
    materializeAgyNativeMcpConfig({
      profileHome: home,
      runtimeRoot,
      serverNames: [],
      memberServer: {
        ...member.server,
        env: { ...pluginMcpEnvironment({ source: 'plugin', env: { ...member.server.env } }, callbackEnv ?? {}) },
      },
    });
    return undefined;
  }
  const ordinary = input.options?.toolExecutionPolicy?.mode !== 'read_only';
  const credential = ordinary && callbackEnv ? prepareAgyNativeCredentialFile(home, callbackEnv) : undefined;
  try {
    const resolvedServers =
      ordinary && credential
        ? await resolveProviderMcpConfig({
            callbackEnv: { ...callbackEnv, CAT_CAFE_CAT_ID: input.catId },
            workingDirectory: input.workspace,
            mcpServerPath: join(runtimeRoot, 'packages/mcp-server/dist/index.js'),
            credentialFile: credential.path,
            provider: 'google',
          })
        : undefined;
    materializeAgyNativeMcpConfig({
      profileHome: home,
      runtimeRoot,
      serverNames: resolvedServers ? Object.keys(resolvedServers) : [],
      ...(resolvedServers ? { resolvedServers } : {}),
      ...(credential ? { callback: { apiUrl: credential.apiUrl, credentialFile: credential.path } } : {}),
    });
    return credential?.dispose;
  } catch (error) {
    credential?.dispose();
    throw error;
  }
}
