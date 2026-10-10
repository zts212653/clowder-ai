'use client';

import { useState } from 'react';
import styles from './RealChatEntry.module.css';

interface RealChatEntryProps {
	members: Array<{ client: string; cat: string; catId: string }>;
	onComplete: (message: string) => void;
}

/**
 * 场景 8: 第一次真实交流
 * 用户输入第一句话，传递给父组件进行真实发送
 */
export function RealChatEntry({ members, onComplete }: RealChatEntryProps) {
	const [showTip, setShowTip] = useState(true);
	const [message, setMessage] = useState('');

	const frontCat = members[0]?.cat || 'siamese';

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!message.trim()) return;

		// 传递用户消息给父组件，由父组件路由到真实 ChatInput
		onComplete(message.trim());
	};

	return (
		<div className={styles.container}>
			<div className={styles.header}>
				<h1>你的第一次交流</h1>
				<span className={styles.realBadge}>真实模型 · 开始协作</span>
			</div>

			<div className={styles.scene}>
				<h2>8. 开始真实协作</h2>
				<p className={styles.lead}>
					现在是真实对话了。{frontCat} 会真正理解你的话，调用模型给出回复。
				</p>

				<div className={styles.stage}>
					<div className={styles.chatDemo}>
						<div className={styles.systemMessage}>
							成员已配置完成：{members.map((m) => m.cat).join('、')}
						</div>
					</div>

					{showTip && (
						<div className={styles.tip}>
							<span>提示：之后可以从左侧“成员”“密钥”管理伙伴和账号。</span>
							<button type="button" onClick={() => setShowTip(false)} className={styles.dismissButton}>
								知道了
							</button>
						</div>
					)}

					<form className={styles.compose} onSubmit={handleSubmit}>
						<textarea
							value={message}
							onChange={(e) => setMessage(e.target.value)}
							placeholder="输入你的第一句话，例如：帮我整理一个欢迎页"
							rows={3}
							className={styles.messageInput}
							autoFocus
						/>
						<div className={styles.actions}>
							<button type="submit" className={styles.primaryButton} disabled={!message.trim()}>
								发送
							</button>
						</div>
					</form>
				</div>
			</div>
		</div>
	);
}
