// Test-only SDK input/close instrumentation, inactive without its explicit flag.
export function patchClaudeIngressFault(input) {
  let text = 'import { spawn as clowderSpawn } from "node:child_process";\n' + input;
  const anchor = '    const q = query({\n      prompt: input,';
  if (!text.includes(anchor)) throw new Error('SDK input fault anchor missing');
  text = text.replace(
    anchor,
    `    const clowderFault = process.env.CLOWDER_SPIKE_HOLD_SDK_NEXT === "1";
    const clowderReport = (detail: Record<string, unknown>) => {
      void this.client.extNotification("_clowder/ingressFault", { sessionId, ...detail }).catch(() => {});
    };
    if (clowderFault) options.spawnClaudeCodeProcess = spawnOptions => {
      const child = clowderSpawn(spawnOptions.command, spawnOptions.args, {
        cwd: spawnOptions.cwd, env: spawnOptions.env, signal: spawnOptions.signal,
        stdio: "pipe", windowsHide: true,
      });
      child.stderr.resume();
      child.on("spawn", () => clowderReport({ phase: "spawned", pid: child.pid }));
      child.on("exit", (code, signal) => clowderReport({ phase: "exited", pid: child.pid, code, signal }));
      return child;
    };
    const clowderPrompt: AsyncIterable<SDKUserMessage> = {
      async *[Symbol.asyncIterator]() {
        for await (const item of input) {
          if (clowderFault && item.priority === "next") {
            clowderReport({ phase: "held", uuid: item.uuid });
            await new Promise(resolve => setTimeout(resolve, 2000));
            clowderReport({ phase: "released", uuid: item.uuid });
          }
          yield item;
        }
      },
    };
    const q = query({
      prompt: clowderPrompt,`,
  );
  return text;
}
