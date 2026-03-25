/**
 * SkillNet 在线搜索弹窗
 * 从 SkillNet 检索并安装技能
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { webRequest } from "../../services/webClient";
import { normalizeSkillNetUrl } from "../../utils/skillNetUrl";

const SKILLNET_UPSTREAM_REPO_URL = "https://github.com/zjunlp/SkillNet";
/** 同时进行的 SkillNet 安装任务上限（与后端 asyncio 能力匹配，避免前端狂点拖垮） */
const SKILLNET_MAX_CONCURRENT_INSTALLS = 5;

type SkillNetItem = {
  skill_name: string;
  skill_description: string;
  author: string;
  stars: number;
  skill_url: string;
  category: string;
};

type LoadState = "idle" | "loading" | "success" | "error";

interface SkillNetSearchModalProps {
  open: boolean;
  sessionId: string;
  /** 当前已安装技能名（兜底，与列表插件判定一致） */
  installedSkillNames?: ReadonlySet<string>;
  /** 已安装技能的来源 URL（规范化后），优先于 skill_name 匹配 SkillNet 结果 */
  installedSkillOrigins?: ReadonlySet<string>;
  onClose: () => void;
  onInstalled?: (skillName: string) => void | Promise<void>;
  /** 点击文案中的「配置页面」时：关闭弹窗并切换到应用内配置页 */
  onNavigateToConfig?: () => void;
}

export function SkillNetSearchModal({
  open,
  sessionId,
  installedSkillNames,
  installedSkillOrigins,
  onClose,
  onInstalled,
  onNavigateToConfig,
}: SkillNetSearchModalProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SkillNetItem[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [expandedUrl, setExpandedUrl] = useState<string | null>(null);
  /** 正在安装中的 skill_url（可多路并发，上限见 SKILLNET_MAX_CONCURRENT_INSTALLS） */
  const [installingUrls, setInstallingUrls] = useState<Set<string>>(() => new Set());
  const installingUrlsRef = useRef<Set<string>>(new Set());
  /** 顶部红条：搜索失败、或并发上限等（与按 URL 的安装失败分离） */
  const [bannerError, setBannerError] = useState<string | null>(null);
  /** 某 skill_url 安装失败时的说明（成功或重试开装时会清除该条） */
  const [installErrorByUrl, setInstallErrorByUrl] = useState<Record<string, string>>({});
  const [installedSuccess, setInstalledSuccess] = useState<string | null>(null);
  const installedSuccessTimerRef = useRef<number | null>(null);

  const withSession = useCallback(
    (params?: Record<string, unknown>) => ({
      ...(params || {}),
      session_id: sessionId,
    }),
    [sessionId]
  );

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    return () => {
      if (installedSuccessTimerRef.current !== null) {
        window.clearTimeout(installedSuccessTimerRef.current);
      }
    };
  }, []);

  const clearInstalledSuccess = useCallback(() => {
    if (installedSuccessTimerRef.current !== null) {
      window.clearTimeout(installedSuccessTimerRef.current);
      installedSuccessTimerRef.current = null;
    }
    setInstalledSuccess(null);
  }, []);

  const handleSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;

    setLoadState("loading");
    setBannerError(null);
    try {
      const data = await webRequest<{
        success: boolean;
        detail?: string;
        detail_key?: string;
        detail_params?: Record<string, unknown>;
        skills?: SkillNetItem[];
      }>("skills.skillnet.search", withSession({ q, limit: 50 }));
      if (!data.success) {
        const message = data.detail_key
          ? t(data.detail_key, data.detail_params as Record<string, string> | undefined)
          : (data.detail?.trim() || t("skills.errors.skillNetSearchFailed"));
        throw new Error(message);
      }
      setResults(data.skills || []);
      setLoadState("success");
      setExpandedUrl(null);
    } catch (err) {
      console.error(err);
      setResults([]);
      setLoadState("error");
      const fallbackDetail = t("skills.errors.skillNetSearchFailedHint");
      const detail =
        err instanceof Error && err.message.trim()
          ? err.message.trim()
          : fallbackDetail;
      setBannerError(
        t("skills.errors.skillNetSearchErrorBanner", { detail })
      );
    }
  }, [query, t, withSession]);

  const syncInstallingState = useCallback(() => {
    setInstallingUrls(new Set(installingUrlsRef.current));
  }, []);

  const handleInstall = useCallback(
    async (item: SkillNetItem) => {
      const url = item.skill_url;
      if (!url) return;
      if (installingUrlsRef.current.has(url)) return;
      if (installingUrlsRef.current.size >= SKILLNET_MAX_CONCURRENT_INSTALLS) {
        setBannerError(
          t("skills.skillNet.concurrentLimitReached", {
            max: SKILLNET_MAX_CONCURRENT_INSTALLS,
          })
        );
        return;
      }
      installingUrlsRef.current.add(url);
      syncInstallingState();
      setBannerError(null);
      setInstallErrorByUrl((prev) => {
        if (!(url in prev)) return prev;
        const next = { ...prev };
        delete next[url];
        return next;
      });
      try {
        const data = await webRequest<{
          success: boolean;
          pending?: boolean;
          install_id?: string;
          detail?: string;
          detail_key?: string;
          detail_params?: Record<string, unknown>;
          skill?: { name?: string };
        }>(
          "skills.skillnet.install",
          withSession({ url: item.skill_url, force: true })
        );
        if (!data.success) {
          const message = data.detail_key
            ? t(data.detail_key, data.detail_params as Record<string, string> | undefined)
            : (data.detail || t("skills.errors.skillNetInstallFailed"));
          throw new Error(message);
        }

        let name: string = item.skill_name;
        if (data.pending && data.install_id) {
          const maxWaitMs = 15 * 60 * 1000;
          const pollMs = 800;
          const t0 = Date.now();
          let finished = false;
          while (Date.now() - t0 < maxWaitMs) {
            const st = await webRequest<{
              success: boolean;
              status?: string;
              detail?: string;
              detail_key?: string;
              detail_params?: Record<string, unknown>;
              skill?: { name?: string };
            }>(
              "skills.skillnet.install_status",
              withSession({ install_id: data.install_id })
            );
            if (st.status === "done" && st.success) {
              name = st.skill?.name || item.skill_name;
              finished = true;
              break;
            }
            if (st.status === "failed" || (!st.success && st.status !== "pending")) {
              const message = st.detail_key
                ? t(st.detail_key, st.detail_params as Record<string, string> | undefined)
                : (st.detail || t("skills.errors.skillNetInstallFailed"));
              throw new Error(message);
            }
            await new Promise((r) => window.setTimeout(r, pollMs));
          }
          if (!finished) {
            throw new Error(t("skills.skillNet.installTimeout"));
          }
        } else {
          name = data.skill?.name || item.skill_name;
        }
        setInstallErrorByUrl((prev) => {
          if (!(url in prev)) return prev;
          const next = { ...prev };
          delete next[url];
          return next;
        });
        setInstalledSuccess(name);
        if (installedSuccessTimerRef.current !== null) {
          window.clearTimeout(installedSuccessTimerRef.current);
        }
        installedSuccessTimerRef.current = window.setTimeout(clearInstalledSuccess, 2000);
        await onInstalled?.(name);
      } catch (err) {
        console.error(err);
        const message =
          err instanceof Error && err.message
            ? err.message
            : t("skills.errors.skillNetInstallFailedHint");
        setInstallErrorByUrl((prev) => ({ ...prev, [url]: message }));
      } finally {
        installingUrlsRef.current.delete(url);
        syncInstallingState();
      }
    },
    [clearInstalledSuccess, onInstalled, syncInstallingState, t, withSession]
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        aria-label={t("common.close")}
      />
      <div className="relative w-full max-w-2xl max-h-[85vh] overflow-hidden rounded-xl border border-border bg-card shadow-2xl animate-rise flex flex-col">
        <div className="flex items-start justify-between gap-3 px-5 py-3 border-b border-border bg-panel flex-shrink-0">
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="text-base font-semibold text-text">
              {t("skills.skillNet.title")}
            </h3>
            <p className="text-[11px] leading-snug text-text-muted">
              <a
                href={SKILLNET_UPSTREAM_REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-accent underline decoration-accent/35 underline-offset-2 hover:text-accent-hover hover:decoration-accent/60"
                aria-label={t("skills.skillNet.titleRepoAria")}
              >
                {t("skills.skillNet.titleRepoLinkText")}
              </a>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-sm bg-secondary text-text-muted hover:text-text hover:bg-card border border-border"
          >
            {t("common.close")}
          </button>
        </div>

        <div className="p-5 overflow-auto flex-1 min-h-0">
          {installedSuccess && (
            <div className="mb-3 px-3 py-2.5 rounded-lg text-sm leading-snug border border-[color:var(--border-ok)] bg-ok-subtle text-ok">
              {t("skills.messages.skillNetInstalled", { name: installedSuccess })}
            </div>
          )}
          <div className="mb-4 rounded-md border border-border bg-secondary/50 px-3 py-2.5 text-xs text-text-muted leading-relaxed">
            <div className="font-medium text-text mb-1.5">
              {t("skills.skillNet.usageNoticeTitle")}
            </div>
            <ul className="list-disc pl-4 space-y-1">
              <li>{t("skills.skillNet.usageNotice3")}</li>
              <li>
                <Trans
                  i18nKey="skills.skillNet.usageNotice1"
                  components={{
                    strong: (
                      <strong className="font-semibold text-text" />
                    ),
                  }}
                />
              </li>
              <li>
                <Trans
                  i18nKey="skills.skillNet.usageNotice2"
                  components={{
                    configLink: (
                      <button
                        type="button"
                        aria-label={t("skills.skillNet.configPageLinkAria")}
                        className="inline p-0 m-0 align-baseline border-0 bg-transparent cursor-pointer font-medium text-accent underline decoration-accent/35 underline-offset-2 hover:text-accent-hover hover:decoration-accent/60"
                        onClick={() => onNavigateToConfig?.()}
                      />
                    ),
                  }}
                />
              </li>
            </ul>
          </div>
          <div className="flex items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder={t("skills.skillNet.searchPlaceholder")}
              className="flex-1 min-w-0 px-3 py-2 rounded-md bg-secondary border border-border text-sm text-text placeholder:text-text-muted"
            />
            <button
              type="button"
              onClick={() => void handleSearch()}
              disabled={loadState === "loading" || !query.trim()}
              className={`px-3 py-2 rounded-md text-sm transition-colors ${
                loadState === "loading" || !query.trim()
                  ? "bg-secondary text-text-muted cursor-not-allowed"
                  : "bg-accent text-white hover:bg-accent-hover"
              }`}
            >
              {loadState === "loading" ? t("common.loading") : t("skills.skillNet.search")}
            </button>
          </div>

          {bannerError && (
            <div className="mt-3 px-3 py-2 rounded-md bg-secondary text-sm text-danger break-words whitespace-pre-wrap max-h-48 overflow-y-auto">
              {bannerError}
            </div>
          )}

          {loadState === "success" && (
            <div className="mt-4 flex min-h-0 max-h-[50vh] flex-col gap-2">
              {installingUrls.size >= SKILLNET_MAX_CONCURRENT_INSTALLS && (
                <div
                  className="flex-shrink-0 rounded-lg border border-amber-500/45 bg-amber-500/12 px-3 py-2.5 text-sm font-medium text-text shadow-sm"
                  role="status"
                >
                  {t("skills.skillNet.concurrentLimitReached", {
                    max: SKILLNET_MAX_CONCURRENT_INSTALLS,
                  })}
                </div>
              )}
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-0.5">
              {results.length === 0 ? (
                <div className="text-xs text-text-muted">{t("skills.skillNet.noResults")}</div>
              ) : (
                results.map((item) => {
                  const byUrl =
                    item.skill_url &&
                    (installedSkillOrigins?.has(
                      normalizeSkillNetUrl(item.skill_url)
                    ) ??
                      false);
                  const byName = installedSkillNames?.has(item.skill_name) ?? false;
                  const isInstalled = Boolean(byUrl || byName);
                  const isInstalling = installingUrls.has(item.skill_url);
                  const atConcurrentLimit =
                    installingUrls.size >= SKILLNET_MAX_CONCURRENT_INSTALLS;
                  const installBlockedByLimit =
                    atConcurrentLimit && !isInstalling;
                  const isExpanded = expandedUrl === item.skill_url;
                  const rowInstallError = installErrorByUrl[item.skill_url];
                  return (
                    <div
                      key={item.skill_url}
                      className="p-2 rounded-md border border-border bg-secondary flex items-start justify-between gap-3 cursor-pointer"
                      onClick={() =>
                        setExpandedUrl((prev) =>
                          prev === item.skill_url ? null : item.skill_url
                        )
                      }
                    >
                      <div className="min-w-0">
                        <div className="text-sm text-text font-medium truncate">
                          {item.skill_name}
                        </div>
                        <div className="text-xs text-text-muted line-clamp-2">
                          {item.skill_description || t("skills.noDescription")}
                        </div>
                        <div className="text-xs text-text-muted mt-1">
                          {t("skills.skillNet.meta", {
                            author: item.author || "unknown",
                            stars: item.stars || 0,
                          })}
                        </div>
                        <div className="text-xs text-text-muted mt-1">
                          {isExpanded
                            ? t("skills.skillNet.hideDetail")
                            : t("skills.skillNet.showDetail")}
                        </div>
                        {isExpanded && (
                          <div className="mt-2 text-xs text-text-muted space-y-1 break-all">
                            <div>
                              {t("skills.skillNet.category")}: {item.category || "unknown"}
                            </div>
                            <div>
                              {t("skills.skillNet.url")}:{" "}
                              <a
                                href={item.skill_url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-accent hover:underline"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {item.skill_url}
                              </a>
                            </div>
                          </div>
                        )}
                      </div>
                      <div
                        className="flex flex-col items-end gap-1 flex-shrink-0 max-w-[min(100%,14rem)]"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {isInstalled ? (
                          <span className="px-3 py-1.5 rounded-md text-xs whitespace-nowrap border border-[color:var(--border-ok)] bg-ok-subtle text-ok">
                            {t("skills.status.installed")}
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleInstall(item);
                            }}
                            disabled={isInstalling || installBlockedByLimit}
                            title={
                              installBlockedByLimit
                                ? t("skills.skillNet.concurrentLimitReached", {
                                    max: SKILLNET_MAX_CONCURRENT_INSTALLS,
                                  })
                                : isInstalling
                                  ? t("skills.skillNet.installingInProgress")
                                  : undefined
                            }
                            className={`px-3 py-1.5 rounded-md text-xs whitespace-nowrap transition-colors ${
                              isInstalling || installBlockedByLimit
                                ? "bg-secondary text-text-muted cursor-not-allowed"
                                : "bg-accent text-white hover:bg-accent-hover"
                            }`}
                          >
                            {isInstalling
                              ? t("skills.skillNet.installingInProgress")
                              : t("skills.skillNet.installFromResult")}
                          </button>
                        )}
                        {rowInstallError ? (
                          <p
                            className="text-[11px] text-danger text-right leading-snug break-words"
                            role="alert"
                          >
                            {rowInstallError}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  );
                })
              )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
