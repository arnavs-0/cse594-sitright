import { PostureAlert, PostureStatus } from '../types'

interface Props {
  alerts: PostureAlert[]
}

const statusCfg: Record<PostureStatus, { color: string; bg: string; icon: JSX.Element }> = {
  good: {
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    ),
  },
  warning: {
    color: 'text-amber-400',
    bg: 'bg-amber-500/10',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    ),
  },
  bad: {
    color: 'text-red-400',
    bg: 'bg-red-500/10',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </svg>
    ),
  },
}

function timeAgo(date: Date): string {
  const diff = Math.floor((Date.now() - date.getTime()) / 1000)
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return date.toLocaleDateString()
}

export default function AlertHistory({ alerts }: Props) {
  if (alerts.length === 0) {
    return (
      <div className="bg-slate-800/50 border border-slate-700/50 rounded-2xl p-4">
        <h3 className="text-sm font-medium text-slate-300 mb-3">Recent Alerts</h3>
        <div className="flex items-center justify-center py-8 text-slate-500">
          <div className="text-center">
            <svg
              className="w-8 h-8 mx-auto mb-2 text-slate-600"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
            <span className="text-xs">No alerts yet — keep up the good posture!</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-slate-800/50 border border-slate-700/50 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-slate-300">Recent Alerts</h3>
        <span className="text-[11px] text-slate-500">{alerts.length} total</span>
      </div>

      <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
        {alerts.slice(0, 20).map((a) => {
          const c = statusCfg[a.type]
          return (
            <div
              key={a.id}
              className={`flex items-start gap-3 p-2.5 rounded-xl ${c.bg} transition-all duration-200`}
            >
              <div className={`mt-0.5 ${c.color}`}>{c.icon}</div>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-slate-200 leading-snug">{a.message}</p>
                <p className="text-[10px] text-slate-500 mt-0.5">
                  {a.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ·{' '}
                  {timeAgo(a.timestamp)}
                </p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
