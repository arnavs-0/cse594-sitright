import { useState, useEffect } from 'react'

interface Props {
  sessionStart: Date
  score: number
  alertCount: number
  isMonitoring: boolean
}

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m ${sec}s`
}

export default function SessionStats({ sessionStart, score, alertCount, isMonitoring }: Props) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const t = setInterval(() => setElapsed(Date.now() - sessionStart.getTime()), 1000)
    return () => clearInterval(t)
  }, [sessionStart])

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
      label: 'Session Duration',
      value: fmt(elapsed),
      sub: `since ${sessionStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
      color: 'text-blue-400',
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
    <div className="grid grid-cols-2 gap-4 h-full">
      {stats.map((s) => (
        <div
          key={s.label}
          className="bg-slate-800/50 border border-slate-700/50 rounded-2xl p-4 flex flex-col justify-between"
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
  )
}
