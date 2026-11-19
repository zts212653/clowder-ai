/**
 * Static provider notification projection loaded once per active package
 * generation. It intentionally carries method names only: envelope fields,
 * thread/turn identity and terminal decisions remain Host-owned.
 */
export interface CodexAppServerNotificationProjection {
  readonly methods: ReadonlySet<string>;
  readonly ignoredMethods: ReadonlySet<string>;
  /** Alias provider method -> existing non-terminal mapper method (display only). */
  readonly aliases: ReadonlyMap<string, string>;
  readonly assertCurrent?: () => Promise<void>;
}
