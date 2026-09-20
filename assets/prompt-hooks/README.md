# Session Hook Pipeline

Each subdirectory is one prompt hook. Its `hook.yaml` manifest and template are
co-located so the registry, Console, tracing, and runtime all refer to the same
hook ID and content source.

At session initialization, `HookPipeline` scans the enabled session hooks and
assembles one ordered prompt. Native and non-native providers consume that same
result; carriers differ only in how they transport it to the model.

Edit a hook in its own directory. There is no separately compiled session
prompt artifact or second manifest protocol.
