# SOP Definitions

`development.yaml` is the machine truth source for Workflow SOP stage ids, labels,
suggested skills, hard rules, pitfalls, owners, severity, and predicate metadata.

Runtime code only consumes top-level `*.yaml` files in this directory. Files under
`stubs/` are schema fixtures for future SOP domains; they validate the
domain-generic shape but do not enter runtime codegen.

After editing YAML, run:

```bash
pnpm gen:sop-definitions
pnpm check:sop-definitions
```

`pnpm gen:sop-definitions` writes
`packages/shared/src/types/sop-definition.generated.ts`. `pnpm check` runs
`check:sop-definitions` and fails when that generated file is stale.
