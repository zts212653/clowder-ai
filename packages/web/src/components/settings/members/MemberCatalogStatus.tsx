import type { MemberText } from './MemberRuntimeFields';
import { nativeAcpProfileMessage } from './native-acp-profile-status';
import type { MemberCatalog } from './useRuntimeCatalog';

export function MemberCatalogStatus({
  catalog,
  notImplemented = false,
  loading,
  needsLogin,
  invalidDefault,
  inheritsModel,
  tool,
  modelCount,
  t,
}: {
  catalog: MemberCatalog | null;
  notImplemented?: boolean;
  loading: boolean;
  needsLogin: boolean;
  invalidDefault: boolean;
  inheritsModel: boolean;
  tool: string;
  modelCount: number;
  t: MemberText;
}) {
  if (notImplemented)
    return (
      <p>
        {t(
          '此入口尚未接入模型与思考强度读取；已保留手动设置。',
          'Model and effort reading is not implemented for this entry; manual settings are preserved.',
        )}
      </p>
    );
  if (needsLogin)
    return (
      <p>
        {t(
          '登录后可读取模型目录；当前可以保留跟随工具设置。',
          'Sign in to read the model catalog; inherited settings can be kept for now.',
        )}
      </p>
    );
  if (loading) return <p>{t(`正在读取 ${tool} 的模型…`, `Reading ${tool} models…`)}</p>;
  if (invalidDefault)
    return (
      <p role="alert">
        {t(
          '客户端报告的默认模型不在可用清单中，请选择有效模型或修正客户端配置后刷新。',
          'The reported default model is unavailable. Select a valid model or fix the client configuration and refresh.',
        )}
      </p>
    );
  if (inheritsModel && catalog?.status === 'live' && catalog.defaultModelStatus === 'unreported')
    return (
      <p>
        {t(
          '已读取模型信息，但默认模型尚未确认。“跟随”会保留客户端选择，不代表已验证可调用。',
          'Model information was read, but the native default is unconfirmed. Following keeps the client choice; it does not verify an invocation.',
        )}
      </p>
    );
  if (catalog?.message === 'custom_model')
    return (
      <p>
        {t(
          '当前模型尚未由客户端探测确认，已保留你的选择；实际执行时仍需校验。',
          'The probe has not confirmed this model. Your choice is preserved and still needs validation at invocation.',
        )}
      </p>
    );
  if (catalog?.status === 'live') return <p>{t(`已读取 ${modelCount} 个模型`, `Read ${modelCount} models`)}</p>;
  if (catalog?.message === 'configured_only')
    return (
      <p>{t('已读取工具本地配置 · 实际连接待验证', 'Local tool configuration read · Connection not yet verified')}</p>
    );
  const profileMessage = nativeAcpProfileMessage(catalog?.message, t);
  if (profileMessage) return <p>{profileMessage}</p>;
  if (catalog?.message === 'account_unavailable')
    return (
      <p>
        {t(
          '此连接暂不可读取。已保留当前选择，请在“管理连接”中检查。',
          'This connection is unavailable. Your selection is preserved; check Manage connections.',
        )}
      </p>
    );
  if (catalog?.message === 'account_catalog')
    return <p>{t('使用此连接保存的模型清单。', 'Using the model list saved with this connection.')}</p>;
  if (catalog?.message === 'custom_startup')
    return (
      <p>
        {t(
          '此成员使用自定义启动配置，请按工具支持的模型选择或手动指定。',
          'This teammate uses a custom launch configuration; select or specify a supported model.',
        )}
      </p>
    );
  return (
    <p>
      {t(
        '模型目录暂不可读取。可以继续跟随工具，或保留已有模型；稍后刷新重试。',
        'Model catalog unavailable. Keep inherited or saved settings, or retry with Refresh.',
      )}
    </p>
  );
}
