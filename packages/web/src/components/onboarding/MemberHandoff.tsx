'use client';

import { useCallback, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import styles from './MemberHandoff.module.css';

interface MemberHandoffProps {
	selectedClients: Array<{ name: string; cliTool: string; provider: string; accountRef?: string; authType?: string }>;
	onComplete: (members: Array<{ client: string; cat: string; catId: string }>) => void;
}

// CLI tool → clientId/provider 映射（符合 client-detection.ts CLI_SPECS）
const CLI_TO_CLIENT_MAP: Record<
	string,
	{ clientId: 'anthropic' | 'openai' | 'google' | 'opencode' | 'kimi'; provider: string }
> = {
	claude: { clientId: 'anthropic', provider: 'anthropic' },
	codex: { clientId: 'openai', provider: 'openai' },
	opencode: { clientId: 'opencode', provider: 'opencode' },
	gemini: { clientId: 'google', provider: 'google' },
	kimi: { clientId: 'kimi', provider: 'kimi' },
};

// 猫品种配置（Phase 1 简化方案，使用英文避免乱码）
// TODO Phase 2: 从 catRegistry 读取并检查冲突
const CAT_CONFIGS = [
	{
		breedId: 'ragdoll',
		name: 'Ragdoll',
		displayName: 'Ragdoll Cat',
		color: { primary: '#e8a983', secondary: '#f5d4c1' },
		roleDescription: 'System architecture and deep design',
		personality: 'Thoughtful, pursuing elegant solutions',
		teamStrengths: 'Complex system modeling, technical specifications',
		mentionPatterns: ['@ragdoll'],
	},
	{
		breedId: 'maine-coon',
		name: 'Maine Coon',
		displayName: 'Maine Coon Cat',
		color: { primary: '#8d9aab', secondary: '#c5cdd6' },
		roleDescription: 'Code review and quality assurance',
		personality: 'Rigorous, focused on maintainability',
		teamStrengths: 'Code review, test coverage, refactoring',
		mentionPatterns: ['@maine-coon'],
	},
	{
		breedId: 'siamese',
		name: 'Siamese',
		displayName: 'Siamese Cat',
		color: { primary: '#d7ba85', secondary: '#ebe0c8' },
		roleDescription: 'User experience and product thinking',
		personality: 'Keen insight, attention to UX details',
		teamStrengths: 'UX design, product polish, copywriting',
		mentionPatterns: ['@siamese'],
	},
];

/**
 * 场景 7: 从示范团队交接到我的伙伴
 * 使用真实 API: POST /api/cats（循环创建，每个 client 一次调用）
 * 符合 cats.ts 的完整 schema，检查 HTTP 状态，解析真实 cat.id
 */
export function MemberHandoff({ selectedClients, onComplete }: MemberHandoffProps) {
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [createdCount, setCreatedCount] = useState(0);

	const handleContinue = useCallback(async () => {
		setCreating(true);
		setError(null);
		setCreatedCount(0);

		const createdMembers: Array<{ client: string; cat: string; catId: string }> = [];

		try {
			// 循环调用 POST /api/cats 创建每个成员
			for (const [index, client] of selectedClients.entries()) {
				const catConfig = CAT_CONFIGS[index % CAT_CONFIGS.length];
				const clientMapping = CLI_TO_CLIENT_MAP[client.cliTool];

				if (!clientMapping) {
					throw new Error(`不支持的 CLI 工具: ${client.cliTool}`);
				}

				const catId = `${catConfig.breedId}-${client.cliTool}`;

				try {
					// 使用 apiFetch，它会自动附加当前用户的身份信息
					const res = await apiFetch('/api/cats', {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({
							catId,
							breedId: catConfig.breedId,
							name: catConfig.name,
							displayName: catConfig.displayName,
							color: catConfig.color,
							mentionPatterns: catConfig.mentionPatterns,
							roleDescription: catConfig.roleDescription,
							personality: catConfig.personality,
							teamStrengths: catConfig.teamStrengths,
							clientId: clientMapping.clientId,
							provider: clientMapping.provider,
							accountRef: client.accountRef, // 账号绑定
							defaultModel: '', // 使用 CLI 默认模型
							mcpSupport: false,
						}),
					});

					// 检查 HTTP 状态
					if (!res.ok) {
						const errText = await res.text();
						throw new Error(`HTTP ${res.status}: ${errText}`);
					}

					const data = await res.json();

					// 解析真实的 cat.id（服务端可能规范化了 catId）
					const realCatId = data.cat?.id || catId;

					createdMembers.push({ client: client.name, cat: catConfig.breedId, catId: realCatId });
					setCreatedCount((prev) => prev + 1);
				} catch (err) {
					// 部分失败：记录已创建的成员，抛出错误
					const errorMsg = err instanceof Error ? err.message : '未知错误';
					throw new Error(
						`创建成员失败：${client.name}（${errorMsg}）。已创建 ${createdMembers.length}/${selectedClients.length} 个成员。`
					);
				}
			}

			// 全部创建成功
			onComplete(createdMembers);
		} catch (err) {
			setError(err instanceof Error ? err.message : '成员创建失败');
			setCreating(false);
		}
	}, [selectedClients, onComplete]);

	const members = selectedClients.map((client, index) => ({
		client: client.name,
		breed: CAT_CONFIGS[index % CAT_CONFIGS.length].breedId,
	}));

	const handoffText =
		members.length === 1
			? '先从你和它开始，之后可以再邀请更多伙伴。'
			: `已按你的选择配置 ${members.length} 位真实伙伴。未选择的演示猫不会出现在成员列表。`;

	const memberList = members.map((m) => `${m.breed}（${m.client}）`).join('、');

	const progressText = creating ? `正在创建成员... (${createdCount}/${selectedClients.length})` : '进入真实主界面';

	return (
		<div className={styles.container}>
			<div className={styles.header}>
				<h1>看懂一次协作，再得到自己的伙伴</h1>
				<span className={styles.mockBadge}>演示数据 · 不调用真实模型</span>
			</div>

			<div className={styles.scene}>
				<h2>7. 从示范团队交接到我的伙伴</h2>
				<p className={styles.lead}>示范猫不会冒充真实成员；解说猫自然留下成为前台猫。</p>

				<div className={styles.stage}>
					<div className={styles.handoff}>
						<div className={`${styles.face} ${styles.siamese}`}>暹</div>
						<div className={styles.handoffText}>
							<b>{memberList} 将加入你的团队</b>
							<p>{handoffText}</p>
							<p className={styles.boundary}>刚才是示范，从这里开始，就是与你自己的猫交流了。</p>
						</div>
					</div>

					{error && <div className={styles.error}>{error}</div>}
				</div>

				<div className={styles.actions}>
					<button type="button" onClick={handleContinue} className={styles.primaryButton} disabled={creating}>
						{progressText}
					</button>
				</div>
			</div>
		</div>
	);
}
