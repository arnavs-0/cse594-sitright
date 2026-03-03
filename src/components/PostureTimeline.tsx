import { PostureSnapshot, PostureStatus } from '../types'

interface Props {
  timeline: PostureSnapshot[]
}

const barColor: Record<PostureStatus, string> = {
  good: 'bg-emerald-500',
  warning: 'bg-amber-500',
  bad: 'bg-red-500',
}

const MAX_BARS = 30

export default function PostureTimeline({ timeline }: Props) {
  const entries = timeline.slice(-MAX_BARS)

  return (
    <div className="bg-slate-800/50 border border-slate-700/50 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-slate-300">Posture Timeline</h3>

        <div className="flex items-center gap-3">
          {(['good', 'warning', 'bad'] as const).map((s) => (
            <div key={s} className="flex items-center gap-1">
              <div className={`w-2 h-2 rounded-full ${barColor[s]}`} />
              <span className="text-[10px] text-slate-500 capitalize">{s}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-end gap-[3px] h-16">
        {/* empty placeholders while collecting data */}
        {Array.from({ length: MAX_BARS - entries.length }).map((_, i) => (
          <div
            key={`e-${i}`}
            className="flex-1 bg-slate-700/30 rounded-sm min-w-[6px]"
            style={{ height: '4px' }}
          />
        ))}

        {entries.map((e, i) => (
          <div
            key={i}
            className={`flex-1 ${barColor[e.status]} rounded-sm min-w-[6px] transition-all duration-300`}
            style={{ height: `${Math.max(15, (e.score / 100) * 100)}%` }}
            title={`Score: ${e.score} — ${e.status}`}
          />
        ))}
      </div>

      {entries.length === 0 && (
        <p className="text-center text-xs text-slate-500 -mt-8">Collecting data…</p>
      )}
    </div>
  )
}
