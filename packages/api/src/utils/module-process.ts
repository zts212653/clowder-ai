/** One trusted operation per process; native work can be terminated by the parent. */
process.once('message', async (request: { moduleUrl: string; exportName: string; input: unknown }) => {
  try {
    const module: Record<string, unknown> =
      import.meta.url.endsWith('.ts') || request.moduleUrl.endsWith('.ts')
        ? await (await import('tsx/esm/api')).tsImport(request.moduleUrl, import.meta.url)
        : await import(request.moduleUrl);
    const operation = module[request.exportName];
    if (typeof operation !== 'function') throw new Error(`Missing worker export: ${request.exportName}`);
    const value: unknown = await operation(request.input);
    process.send?.({ ok: true, value }, () => process.exit(0));
  } catch (error) {
    process.send?.(
      {
        ok: false,
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        },
      },
      () => process.exit(1),
    );
  }
});
