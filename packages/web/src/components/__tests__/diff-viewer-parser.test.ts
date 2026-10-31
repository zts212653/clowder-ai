import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '@/components/workspace/DiffViewer';

const sampleDiff = `diff --git a/src/app.ts b/src/app.ts
index abc1234..def5678 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,7 +10,8 @@ function main() {
   const a = 1;
   const b = 2;
-  const c = 3;
+  const c = 4;
+  const d = 5;
   return a + b;
 }
`;

const multiFileDiff = `diff --git a/foo.ts b/foo.ts
--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,3 @@
 line1
-old
+new
 line3
diff --git a/bar.ts b/bar.ts
--- a/bar.ts
+++ b/bar.ts
@@ -5,3 +5,4 @@ export function bar() {
   const x = 1;
   const y = 2;
+  const z = 3;
 }
`;

describe('parseUnifiedDiff', () => {
  it('parses single file diff with add/remove/context lines', () => {
    const files = parseUnifiedDiff(sampleDiff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/app.ts');
    expect(files[0].hunks).toHaveLength(1);

    const lines = files[0].hunks[0].lines;
    // A final newline terminates the closing-brace line; it is not a ninth blank context line.
    expect(lines).toHaveLength(8);
    expect(lines.at(-1)).toEqual({ type: 'context', content: '}', oldLine: 14, newLine: 15 });

    const removes = lines.filter((l) => l.type === 'remove');
    const adds = lines.filter((l) => l.type === 'add');
    expect(removes).toHaveLength(1);
    expect(adds).toHaveLength(2);
    expect(removes[0].content).toBe('  const c = 3;');
    expect(adds[0].content).toBe('  const c = 4;');
    expect(adds[1].content).toBe('  const d = 5;');
  });

  it('tracks line numbers correctly', () => {
    const files = parseUnifiedDiff(sampleDiff);
    const lines = files[0].hunks[0].lines;

    // First context line: old=10, new=10
    const firstContext = lines.find((l) => l.type === 'context');
    expect(firstContext?.oldLine).toBe(10);
    expect(firstContext?.newLine).toBe(10);

    // Remove line: old=12, new=null
    const removeLine = lines.find((l) => l.type === 'remove');
    expect(removeLine?.oldLine).toBe(12);
    expect(removeLine?.newLine).toBeNull();

    // First add line: old=null, new=12
    const addLine = lines.find((l) => l.type === 'add');
    expect(addLine?.oldLine).toBeNull();
    expect(addLine?.newLine).toBe(12);
  });

  it('parses multi-file diff', () => {
    const files = parseUnifiedDiff(multiFileDiff);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe('foo.ts');
    expect(files[1].path).toBe('bar.ts');
  });

  it('returns empty array for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('  \n  ')).toEqual([]);
  });

  it('handles new file diffs', () => {
    const newFileDiff = `diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,3 @@
+line1
+line2
+line3
`;
    const files = parseUnifiedDiff(newFileDiff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('new.ts');
    const adds = files[0].hunks[0].lines.filter((l) => l.type === 'add');
    expect(adds).toHaveLength(3);
  });

  it('handles deleted file diffs (+++ /dev/null)', () => {
    const deletedDiff = `diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-line1
-line2
-line3
`;
    const files = parseUnifiedDiff(deletedDiff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('old.ts');
    const removes = files[0].hunks[0].lines.filter((l) => l.type === 'remove');
    expect(removes).toHaveLength(3);
  });

  it('handles renamed file diffs (diff --git path used as source)', () => {
    const renameDiff = `diff --git a/old-name.ts b/new-name.ts
similarity index 90%
rename from old-name.ts
rename to new-name.ts
--- a/old-name.ts
+++ b/new-name.ts
@@ -1,3 +1,3 @@
 line1
-oldContent
+newContent
 line3
`;
    const files = parseUnifiedDiff(renameDiff);
    expect(files).toHaveLength(1);
    // Path should be the new name (from +++ b/ override)
    expect(files[0].path).toBe('new-name.ts');
  });
});
