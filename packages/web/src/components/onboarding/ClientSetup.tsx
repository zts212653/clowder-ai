'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import styles from './ClientSetup.module.css';

interface DetectedClient {
	client: string; // 身份标识（anthropic, openai 等）
	provider: string;
	label: string; // 显示名
	cli: string; // CLI 命令
	installed: boolean;
	authenticated: boolean;
	accountRef?: string;
	authType?: string;
}

interface ClientSetupProps {
	onComplete: (
		clients: Array<{ name: string; cliTool: string; provider: string; accountRef?: string; authType?: string }>,
	) => void;
}

/**
 * 场景 6: 检测本机 client
 * 使用真实 API: GET /api/first-run/available-clients
 * 部署边界：仅桌面应用支持（本地 API 探测本地环境）
 */
export function ClientSetup({ onComplete }: ClientSetupProps) {
	const [clients, setClients] = useState<DetectedClient[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());

	// 探测本机 client（调用真实 API）
	const detectClients = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await apiFetch('/api/first-run/available-clients');

			// 检查 HTTP 状态
			if (!res.ok) {
				const errText = await res.text();
				throw new Error(`Client 探测失败: ${res.status} ${errText}`);
			}

			const data = await res.json();

			// 使用真实字段：client (身份), provider, label (显示名), cli (CLI 命令), installed, authenticated
			const converted: DetectedClient[] = data.clients
				.filter((c: DetectedClient) => c.installed && c.authenticated) // 只保留已安装且已认证的
				.map((c: DetectedClient) => ({
					client: c.client,
					provider: c.provider,
					label: c.label,
					cli: c.cli,
					installed: c.installed,
					authenticated: c.authenticated,
					accountRef: c.accountRef,
					authType: c.authType,
				}));

			setClients(converted);

			// 自动选择所有已认证的 client
			const autoSelected = new Set(converted.map((c) => c.client));
			setSelected(autoSelected);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Client 探测失败');
			setClients([]);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		detectClients();
	}, [detectClients]);

	const handleToggle = useCallback((client: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(client)) {
				next.delete(client);
			} else {
				next.add(client);
			}
			return next;
		});
	}, []);

	const canContinue = selected.size > 0;

	const handleContinue = useCallback(() => {
		if (!canContinue) return;
		const selectedClients = clients
			.filter((c) => selected.has(c.client))
			.map((c) => ({
				name: c.label,
				cliTool: c.cli,
				provider: c.provider,
				accountRef: c.accountRef,
				authType: c.authType,
			}));
		onComplete(selectedClients);
	}, [canContinue, clients, selected, onComplete]);

	return (
		<div className={styles.container}>
			<div className={styles.header}>
				<h1>看懂一次协作，再得到自己的伙伴</h1>
				<span className={styles.mockBadge}>演示数据 · 不调用真实模型</span>
			</div>

			<div className={styles.scene}>
				<h2>6. 检测本机 client</h2>
				<p className={styles.lead}>探测本地安装并已认证的 CLI。</p>

				{clients.length === 0 && !loading && (
					<div className={styles.notice}>
						未检测到已安装且已认证的 client。请先安装并认证一个支持的 CLI，完成后点击“重新检测”。
						{error && <div className={styles.error}>{error}</div>}
					</div>
				)}

				<div className={styles.stage}>
					{loading ? (
						<div className={styles.loading}>正在探测本机 CLI...</div>
					) : clients.length === 0 ? (
						<div className={styles.noClients}>
							<p>未检测到已安装且已认证的 client。</p>
							<div className={styles.installLinks}>
								<a href="https://claude.ai/code" target="_blank" rel="noopener noreferrer">
									安装 Claude Code
								</a>
								<a href="https://openai.com/codex" target="_blank" rel="noopener noreferrer">
									安装 Codex
								</a>
							</div>
						</div>
					) : (
						<div className={styles.clients}>
							{clients.map((client) => (
								<div key={client.client} className={`${styles.client} ${styles.ready}`}>
									<input
										type="checkbox"
										checked={selected.has(client.client)}
										onChange={() => handleToggle(client.client)}
									/>
									<div className={styles.clientInfo}>
										<strong>{client.label}</strong>
										<small>已认证，可绑定成员</small>
									</div>
									<span className={`${styles.state} ${styles.stateOk}`}>可用</span>
								</div>
							))}
						</div>
					)}
				</div>

				<div className={styles.actions}>
					<button type="button" onClick={detectClients} className={styles.button} disabled={loading}>
						重新检测
					</button>
					<button type="button" onClick={handleContinue} className={styles.primaryButton} disabled={!canContinue}>
						确认并进入交接
					</button>
				</div>
			</div>
		</div>
	);
}
