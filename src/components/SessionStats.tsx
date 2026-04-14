import { useEffect, useMemo, useState } from 'react'
import { PostureAlert, PostureSnapshot, PostureStatus, SessionSummary } from '../types'

interface Props {
  sessionStart: Date | null
  status: PostureStatus
  score: number
  alertCount: number
  isMonitoring: boolean
  isSessionActive: boolean
  sessionTimeline: PostureSnapshot[]
  sessionAlerts: PostureAlert[]
  lastSessionSummary: SessionSummary | null
  overlayEnabled: boolean
  onOverlayEnabledChange: (enabled: boolean) => void
  onStartSession: () => void
  onStopSession: () => void
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}h ${m}m ${sec}s` : `${m}m ${sec}s`
}

function averageScore(samples: PostureSnapshot[]): number {
  if (samples.length === 0) return 0
  return Math.round(samples.reduce((sum, sample) => sum + sample.score, 0) / samples.length)
}

function smoothScores(points: PostureSnapshot[], windowSize = 4): number[] {
  return points.map((_, index) => {
    const start = Math.max(0, index - windowSize + 1)
    const slice = points.slice(start, index + 1)
    return slice.reduce((sum, item) => sum + item.score, 0) / slice.length
  })
}

function buildPath(values: number[], width: number, height: number): string {
  if (values.length === 0) return ''
  if (values.length === 1) {
    const y = height - (values[0] / 100) * height
    return `M 0 ${y} L ${width} ${y}`
  }

  return values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width
      const y = height - (value / 100) * height
      return `${index === 0 ? 'M' : 'L'} ${x} ${y}`
    })
    .join(' ')
}

function SessionTrend({ timeline }: { timeline: PostureSnapshot[] }) {
  if (timeline.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 rounded-2xl border border-dashed border-slate-700 bg-slate-900/40 text-sm text-slate-500">
        Session graph will appear after a few samples are collected.
      </div>
    )
  }

  const width = 520
  const height = 140
  const rawScores = timeline.map((point) => point.score)
  const smoothed = smoothScores(timeline)
  const rawPath = buildPath(rawScores, width, height)
  const smoothPath = buildPath(smoothed, width, height)

  return (
    <div className="rounded-2xl border border-slate-700/60 bg-slate-900/50 p-3">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h4 className="text-sm font-medium text-slate-200">Score Trend</h4>
          <p className="text-[11px] text-slate-500">Raw score with a short moving-average overlay.</p>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-slate-500">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-sky-400" />
            Raw
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            Smoothed
          </span>
        </div>
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-40">
        {[25, 50, 75].map((tick) => {
          const y = height - (tick / 100) * height
          return (
            <g key={tick}>
              <line x1="0" x2={width} y1={y} y2={y} stroke="#334155" strokeDasharray="4 4" />
              <text x="6" y={Math.max(12, y - 4)} fill="#64748b" fontSize="10">
                {tick}
              </text>
            </g>
          )
        })}
        <path d={rawPath} fill="none" stroke="#38bdf8" strokeWidth="2" strokeOpacity="0.45" />
        <path d={smoothPath} fill="none" stroke="#34d399" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </div>
  )
}

function FeedbackList({ alerts }: { alerts: PostureAlert[] }) {
  const items = Array.from(
    alerts.reduce((map, alert) => {
      map.set(alert.message, (map.get(alert.message) ?? 0) + 1)
      return map
    }, new Map<string, number>()),
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)

  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-700/60 bg-slate-900/50 p-4 text-sm text-slate-500">
        No posture corrections were triggered during this session.
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-slate-700/60 bg-slate-900/50 p-4">
      <h4 className="text-sm font-medium text-slate-200 mb-3">Most Common Feedback</h4>
      <div className="space-y-2">
        {items.map(([message, count]) => (
          <div key={message} className="flex items-start justify-between gap-4 rounded-xl bg-slate-800/70 px-3 py-2">
            <span className="text-sm text-slate-300 leading-snug">{message}</span>
            <span className="text-xs text-slate-500 whitespace-nowrap">{count}x</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function SessionStats({
  sessionStart,
  status,
  score,
  alertCount,
  isMonitoring,
  isSessionActive,
  sessionTimeline,
  sessionAlerts,
  lastSessionSummary,
  overlayEnabled,
  onOverlayEnabledChange,
  onStartSession,
  onStopSession,
}: Props) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!isSessionActive || !sessionStart) {
      setElapsed(0)
      return
    }

    setElapsed(Date.now() - sessionStart.getTime())
    const t = setInterval(() => setElapsed(Date.now() - sessionStart.getTime()), 1000)
    return () => clearInterval(t)
  }, [isSessionActive, sessionStart])

  const liveTimeline = useMemo(() => {
    if (!isSessionActive) return sessionTimeline
    const livePoint = { time: new Date(), status, score }
    const lastPoint = sessionTimeline[sessionTimeline.length - 1]

    if (!lastPoint) return [livePoint]

    const lastAgeMs = Date.now() - lastPoint.time.getTime()
    if (lastAgeMs < 1000 && lastPoint.score === score && lastPoint.status === status) {
      return sessionTimeline
    }

    return [...sessionTimeline, livePoint]
  }, [isSessionActive, score, sessionTimeline, status, elapsed])

  const liveAverage = useMemo(
    () => (liveTimeline.length > 0 ? averageScore(liveTimeline) : score),
    [liveTimeline, score],
  )
  const detailTimeline = isSessionActive ? liveTimeline : lastSessionSummary?.timeline ?? []
  const feedbackAlerts = isSessionActive ? sessionAlerts : lastSessionSummary?.alerts ?? []

  const stats = [
    {
      label: 'Current Score',
      value: isMonitoring ? `${score}` : '—',
      sub: isMonitoring ? 'out of 100' : 'paused',
      color: score >= 75 ? 'text-emerald-400' : score >= 45 ? 'text-amber-400' : 'text-red-400',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
        </svg>
      ),
    },
    {
      label: 'Session',
      value: isSessionActive ? fmt(elapsed) : lastSessionSummary ? fmt(lastSessionSummary.durationMs) : 'Ready',
      sub: isSessionActive
        ? `avg ${liveAverage || score}/100`
        : lastSessionSummary
          ? `ended ${lastSessionSummary.endedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
          : 'start tracking a focused block',
      color: isSessionActive ? 'text-sky-400' : lastSessionSummary ? 'text-violet-300' : 'text-slate-300',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      ),
    },
    {
      label: 'Alerts Today',
      value: `${alertCount}`,
      sub: alertCount === 0 ? 'no alerts yet' : `${alertCount} posture alert${alertCount > 1 ? 's' : ''}`,
      color: alertCount === 0 ? 'text-emerald-400' : 'text-amber-400',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      ),
    },
    {
      label: 'Status',
      value: isMonitoring ? 'Active' : 'Paused',
      sub: isMonitoring ? 'monitoring posture' : 'click eye to resume',
      color: isMonitoring ? 'text-emerald-400' : 'text-slate-400',
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      ),
    },
  ]

  return (
    <div className="space-y-4 h-full">
      <div className="grid grid-cols-2 gap-4">
        {stats.map((s) => (
          <div
            key={s.label}
            className="bg-slate-800/50 border border-slate-700/50 rounded-2xl p-4 flex flex-col justify-between min-h-[118px]"
          >
            <div className="flex items-center gap-2 text-slate-500 mb-3">
              {s.icon}
              <span className="text-xs font-medium">{s.label}</span>
            </div>
            <div>
              <div className={`text-2xl font-bold ${s.color} transition-colors duration-300`}>
                {s.value}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">{s.sub}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-slate-800/50 border border-slate-700/50 rounded-2xl p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <h3 className="text-sm font-medium text-slate-200">
              {isSessionActive ? 'Current Session' : lastSessionSummary ? 'Last Session Summary' : 'Session Tracking'}
            </h3>
            <p className="text-xs text-slate-500 mt-1 max-w-xl">
              {isSessionActive
                ? 'A session captures your posture trend, running average score, and the feedback triggered during this block.'
                : lastSessionSummary
                  ? 'Your most recent session stays here after you stop it so you can review how posture changed over time.'
                  : 'Start a session when you want a focused summary for a class, study block, or work sprint.'}
            </p>
          </div>

          <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
            <label className="flex items-start gap-3 rounded-xl border border-slate-700/60 bg-slate-900/50 px-3 py-2 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={overlayEnabled}
                onChange={(e) => onOverlayEnabledChange(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-500 bg-slate-900 text-indigo-500 accent-indigo-500"
              />
              <span className="leading-tight">
                <span className="block text-sm font-medium text-slate-100">Red posture overlay</span>
                <span className="block text-[11px] text-slate-400">Show the screen tint only when this is checked.</span>
              </span>
            </label>
            <button
              onClick={onStartSession}
              disabled={isSessionActive}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                isSessionActive
                  ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
                  : 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30'
              }`}
            >
              Start Session
            </button>
            <button
              onClick={onStopSession}
              disabled={!isSessionActive}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                isSessionActive
                  ? 'bg-rose-500/20 text-rose-300 hover:bg-rose-500/30'
                  : 'bg-slate-700 text-slate-500 cursor-not-allowed'
              }`}
            >
              Stop Session
            </button>
          </div>
        </div>

        {!isSessionActive && !lastSessionSummary && (
          <div className="mt-5 rounded-2xl border border-dashed border-slate-700 bg-slate-900/30 p-6 text-sm text-slate-500">
            No session has been recorded yet. Monitoring can keep running in the background, but session summaries begin only after you press Start Session.
          </div>
        )}

        {(isSessionActive || lastSessionSummary) && (
          <div className="mt-5 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <SummaryCard
                label={isSessionActive ? 'Elapsed Time' : 'Total Time'}
                value={isSessionActive ? fmt(elapsed) : fmt(lastSessionSummary?.durationMs ?? 0)}
                sub={
                  isSessionActive && sessionStart
                    ? `started ${sessionStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                    : lastSessionSummary
                      ? `from ${lastSessionSummary.startedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                      : ''
                }
              />
              <SummaryCard
                label={isSessionActive ? 'Running Average' : 'Average Score'}
                value={`${isSessionActive ? liveAverage || score : lastSessionSummary?.averageScore ?? 0}`}
                sub="out of 100"
                valueColor={
                  (isSessionActive ? liveAverage || score : lastSessionSummary?.averageScore ?? 0) >= 75
                    ? 'text-emerald-400'
                    : (isSessionActive ? liveAverage || score : lastSessionSummary?.averageScore ?? 0) >= 45
                      ? 'text-amber-400'
                      : 'text-red-400'
                }
              />
              <SummaryCard
                label="Feedback Events"
                value={`${feedbackAlerts.length}`}
                sub={feedbackAlerts.length === 0 ? 'no corrections logged' : 'poor-posture prompts recorded'}
              />
            </div>

            <SessionTrend timeline={detailTimeline} />
            <FeedbackList alerts={feedbackAlerts} />
          </div>
        )}
      </div>
    </div>
  )
}

function SummaryCard({
  label,
  value,
  sub,
  valueColor = 'text-slate-100',
}: {
  label: string
  value: string
  sub: string
  valueColor?: string
}) {
  return (
    <div className="rounded-2xl border border-slate-700/60 bg-slate-900/50 p-4">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-2xl font-semibold mt-2 ${valueColor}`}>{value}</div>
      <div className="text-xs text-slate-500 mt-1">{sub}</div>
    </div>
  )
}
