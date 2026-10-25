/** The provider owns execution; this plugin only checks arguments and payloads. */
const LOCAL_TOOLS = new Set([
  'bash',
  'read',
  'write',
  'edit',
  'apply_patch',
  'glob',
  'grep',
  'list',
  'ls',
  'todowrite',
  'todoread',
]);

export async function SecretContentProtection({ directory }) {
  const nodeCommand = process.env.CAT_CAFE_GUARD_NODE;
  let configured = false;
  const pending = new Map();
  const dispose = () => {
    for (const entry of pending.values()) entry.dispose();
    pending.clear();
  };
  process.once('exit', dispose);
  return {
    config: async (config) => {
      try {
        if (!nodeCommand) throw new Error('secret_node_runtime_unavailable');
        const { withOpenCodeSecretGuard } = await import('../packages/mcp-server/dist/secret-opencode-config.js');
        withOpenCodeSecretGuard(config, process.env, nodeCommand);
        configured = true;
      } catch {
        configured = false;
        process.stderr.write('secret_native_guard_unavailable: tool execution is blocked.\n');
      }
    },
    'tool.execute.before': async (input, output) => {
      // A missing MCP adapter must not take away the native tools used to repair
      // it. Those tools still run the complete shared input/read check below.
      if (!configured && !LOCAL_TOOLS.has(input.tool)) throw new Error('secret_native_guard_unavailable');
      if (pending.size >= 256 || pending.has(input.callID)) throw new Error('secret_tool_lease_unavailable');
      try {
        const { prepareSecretToolInput } = await import('./lib/secret-tool-io.mjs');
        const prepared = prepareSecretToolInput(input.tool, output.args, { cwd: directory });
        output.args = prepared.input;
        pending.set(input.callID, prepared);
      } catch (error) {
        throw new Error(error.code ?? 'secret_payload_uninspectable');
      }
    },
    'tool.execute.after': async (input) => {
      pending.get(input.callID)?.dispose();
      pending.delete(input.callID);
    },
    event: async ({ event }) => {
      if (event.type === 'server.instance.disposed') {
        dispose();
        process.off('exit', dispose);
      }
    },
  };
}
