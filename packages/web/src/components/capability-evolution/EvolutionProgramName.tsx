import { evolutionProgramDisplayNameSchema } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import type { EvolutionProgramProjection } from './evolution-program-projection';
import { useEvolutionLifecycle } from './use-evolution-lifecycle';

/** Naming is explicit Program metadata, not an interpretation of an opaque asset reference. */
export function EvolutionProgramName({ projection }: { projection: EvolutionProgramProjection }) {
  const [name, setName] = useState(projection.program.displayName ?? '');
  const command = useEvolutionLifecycle(projection);
  useEffect(() => {
    setName(projection.program.displayName ?? '');
  }, [projection.program.displayName]);
  return (
    <details className="mt-3 text-xs text-cafe-secondary">
      <summary className="cursor-pointer">{projection.program.displayName ? '修改项目名称' : '补充项目名称'}</summary>
      <form
        className="mt-3 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = evolutionProgramDisplayNameSchema.safeParse(name);
          if (parsed.success) void command.run({ type: 'name', displayName: parsed.data });
        }}
      >
        <label className="block">
          项目名称
          <input
            className="mt-2 block w-full rounded-lg border border-cafe-subtle bg-cafe-surface px-3 py-2 text-sm text-cafe"
            value={name}
            maxLength={120}
            required
            disabled={command.pending}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="evolution-link"
          disabled={command.pending || !evolutionProgramDisplayNameSchema.safeParse(name).success}
        >
          {command.pending ? '正在保存…' : '保存名称'}
        </button>
        {command.notice && (
          <p role="status" className="evolution-empty">
            {command.notice}
          </p>
        )}
      </form>
    </details>
  );
}
