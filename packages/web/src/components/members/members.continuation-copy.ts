export const continuationCopy = {
  zh: {
    contextStatus: (strategy: string, status: string) => `当前执行状态（已保存的${strategy}设置）：${status}`,
    contextDraftUnconfirmed: '此处理方式尚未保存，执行状态保存后确认。',
    contextDegraded: '不执行',
    hybridActionHint: '执行状态为“可用”时，达到此比例：压缩次数未满就由客户端决定是否压缩，满了就交接到新会话。',
    cliActualCall: (cli: string, url: string) => `${cli} CLI 实际调用：${url}`,
    cliGoogleWarning: '注意：Google 官方接入地址仍要求内置 OAuth；第三方网关使用这里显示的地址。',
  },
  en: {
    contextStatus: (strategy: string, status: string) => `Run status (saved ${strategy} settings): ${status}`,
    contextDraftUnconfirmed: 'This strategy has not been saved. Save it to confirm its run status.',
    contextDegraded: 'Will not run',
    hybridActionHint:
      'When this strategy is available: at this level, the client may compress until the limit is reached; after that, the session hands off.',
    cliActualCall: (cli: string, url: string) => `${cli} CLI request: ${url}`,
    cliGoogleWarning:
      'Note: Google’s official endpoint requires built-in OAuth. A third-party gateway uses the address shown here.',
  },
};
