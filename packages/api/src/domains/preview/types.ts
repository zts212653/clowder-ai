/** Preview Gateway 配置 */
export interface PreviewGatewayConfig {
  /** Gateway 监听端口（独立 origin） */
  port: number;
  /** 允许的目标端口范围 */
  allowedPortRange: [number, number];
  /** 排除的端口列表（Clowder AI 自身服务） */
  excludedPorts: number[];
}

/** 端口发现结果 */
export interface DiscoveredPort {
  port: number;
  source: 'stdout' | 'lsof';
  framework?: string;
  paneId?: string;
  worktreeId: string;
  reachable: boolean;
  discoveredAt: number;
}

/** 端口校验结果 */
export interface PortValidationResult {
  allowed: boolean;
  reason?: string;
}

/** 端口校验选项 */
export interface PortValidationOptions {
  host?: string;
  excludedPorts?: number[];
  gatewaySelfPort?: number;
  /** Runtime-configured ports to exclude (read from env at startup) */
  runtimePorts?: number[];
}
