export const LIBRARY_KINDS: Record<string, string> = {
  project: '项目',
  global: '全局',
  world: '世界',
  domain: '领域',
  research: '调研',
  lesson: '教训',
  decision: '决策',
  method: '方法',
};
export const LIBRARY_VISIBILITY: Record<string, string> = {
  public: '公开',
  internal: '内部',
  private: '私有',
  restricted: '受限',
};
export function libraryVisibility(value: string | null | undefined): string {
  return value && Object.hasOwn(LIBRARY_VISIBILITY, value) ? LIBRARY_VISIBILITY[value] : '范围没有记录下来';
}
const VISIBILITY_ORDER: Record<string, number> = { restricted: 0, private: 1, internal: 2, public: 3 };
export function widensLibraryVisibility(source: string | null | undefined, target: string): boolean {
  return (
    !!source &&
    Object.hasOwn(VISIBILITY_ORDER, source) &&
    Object.hasOwn(VISIBILITY_ORDER, target) &&
    VISIBILITY_ORDER[target] > VISIBILITY_ORDER[source]
  );
}
