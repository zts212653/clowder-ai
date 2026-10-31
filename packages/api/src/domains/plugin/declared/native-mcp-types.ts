/** Host materialization output, never resolved from user-editable MCP configuration. */
export interface NativeMcpServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly workingDirectory: string;
  readonly transport: 'stdio';
}
