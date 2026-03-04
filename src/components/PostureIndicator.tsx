import { PostureStatus } from '../types'

interface Props {
  status: PostureStatus
  score: number
  confidence: number
  isMonitoring: boolean
}

const cfg: Record<PostureStatus, { color: string; ring: string; label: string; glow: string; border: string }> = {
  good: {
    color: 'text-emerald-400',
    ring: 'stroke-emerald-500',
    label: 'Good Posture',
    glow: 'shadow-emerald-500/20',
    border: 'border-emerald-500/50',
  },
  warning: {
    color: 'text-amber-400',
    ring: 'stroke-amber-500',
    label: 'Needs Adjustment',
    glow: 'shadow-amber-500/20',
    border: 'border-amber-500/50',
  },
  bad: {
    color: 'text-red-400',
    ring: 'stroke-red-500',
    label: 'Poor Posture',
    glow: 'shadow-red-500/20',
    border: 'border-red-500/50',
  },
}

export default function PostureIndicator({ status, score, confidence, isMonitoring }: Props) {
  const c = cfg[status]
  const circumference = 2 * Math.PI * 54
  const offset = circumference - (score / 100) * circumference

  return (
    <div
      className={`bg-slate-800/50 border-2 rounded-2xl p-6 flex flex-col items-center justify-center shadow-lg transition-all duration-500 h-full ${
        isMonitoring ? `${c.border} ${c.glow}` : 'border-slate-700/50 shadow-none'
      }`}
    >
      {/* SVG ring */}
      <div className="relative w-36 h-36 mb-4">
        <svg className="w-full h-full -rotate-90" viewBox="0 0 120 120">
          {/* track */}
          <circle cx="60" cy="60" r="54" fill="none" stroke="#1e293b" strokeWidth="8" />
          {/* score arc */}
          {isMonitoring && (
            <circle
              cx="60"
              cy="60"
              r="54"
              fill="none"
              className={c.ring}
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              style={{ transition: 'stroke-dashoffset 1s ease, stroke 0.5s ease' }}
            />
          )}
        </svg>

        {/* center label */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {isMonitoring ? (
            <>
              <span className={`text-3xl font-bold ${c.color} transition-colors duration-500`}>
                {score}
              </span>
              <span className="text-[11px] text-slate-500 font-medium">/ 100</span>
            </>
          ) : (
            <span className="text-sm text-slate-500">Paused</span>
          )}
        </div>
      </div>

      <span className={`text-sm font-semibold ${c.color} transition-colors duration-500`}>
        {isMonitoring ? c.label : 'Monitoring Paused'}
      </span>

      {isMonitoring && (
        <div className="flex items-center gap-1.5 mt-2">
          <div className="w-1.5 h-1.5 rounded-full bg-slate-600" />
          <span className="text-[11px] text-slate-500">Confidence: {confidence}%</span>
        </div>
      )}
    </div>
  )
}
