import type { HealthReportData } from './HealthReport';

function MetricCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="flex-1 rounded-xl border border-cafe bg-white p-4">
      <div className="text-xs text-cafe-secondary">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-cafe-black">{value}</div>
      <div className="mt-0.5 text-[10px] text-cafe-muted">{sub}</div>
    </div>
  );
}

export function LibraryHealthSection({ report }: { report: HealthReportData }) {
  const hasLibraryMetrics = report.staleAnchors || report.orphanEdges || report.searchQuality;
  if (!hasLibraryMetrics) return null;

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-cafe-black">Library Health</h3>

      <div className="flex gap-3">
        {report.staleAnchors != null && (
          <MetricCard label="Stale Anchors" value={String(report.staleAnchors.count)} sub="source files deleted" />
        )}
        {report.orphanEdges != null && (
          <MetricCard label="Orphan Edges" value={String(report.orphanEdges.count)} sub="dangling graph references" />
        )}
        {report.knowledgeFeed != null && (
          <MetricCard
            label="Knowledge Feed"
            value={String(report.knowledgeFeed.pendingCount)}
            sub={`${report.knowledgeFeed.needsReviewCount} needs review`}
          />
        )}
      </div>

      {report.searchQuality && report.searchQuality.totalSearches > 0 && (
        <div className="rounded-xl border border-cafe bg-white p-5">
          <h4 className="mb-3 text-sm font-semibold text-cafe-black">Search Quality</h4>
          <div className="mb-3 flex gap-4 text-xs text-cafe-secondary">
            <span>{report.searchQuality.totalSearches} total searches</span>
            <span>{report.searchQuality.zeroHitCount} zero-hit</span>
            <span>{report.searchQuality.lowHitCount} low-hit (&le;2)</span>
          </div>
          {report.searchQuality.recentMisses.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] font-medium text-cafe-muted">Recent misses</div>
              {report.searchQuality.recentMisses.slice(0, 5).map((m) => (
                <div key={`${m.query}-${m.searchedAt}`} className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-cafe-black">{m.query}</span>
                  <span className="text-cafe-muted">{new Date(m.searchedAt).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {report.replayDrift?.available && (
        <div className="rounded-xl border border-cafe bg-white p-5">
          <h4 className="mb-2 text-sm font-semibold text-cafe-black">Replay Drift</h4>
          <div className="flex gap-4 text-xs text-cafe-secondary">
            <span>{report.replayDrift.sampleCount} repeated queries</span>
            {report.replayDrift.avgSimilarity != null && (
              <span>avg similarity: {(report.replayDrift.avgSimilarity * 100).toFixed(1)}%</span>
            )}
          </div>
        </div>
      )}

      {report.staleAnchors && report.staleAnchors.items.length > 0 && (
        <div className="rounded-xl border border-conn-amber-ring bg-conn-amber-bg p-4">
          <h4 className="mb-2 text-xs font-semibold text-conn-amber-text">Stale Anchors</h4>
          <div className="space-y-1">
            {report.staleAnchors.items.slice(0, 10).map((item) => (
              <div key={item.anchor} className="flex items-center gap-2 text-xs text-conn-amber-text">
                <span className="font-mono">{item.anchor}</span>
                <span className="text-conn-amber-text">&rarr; {item.sourcePath}</span>
              </div>
            ))}
            {report.staleAnchors.items.length > 10 && (
              <div className="text-[10px] text-conn-amber-text">+{report.staleAnchors.items.length - 10} more</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
