import { ScoreExplanation } from '../types'

interface Props {
  explanation: ScoreExplanation
  isMonitoring: boolean
}

const impactStyles = {
  positive: 'border-emerald-500/25 bg-emerald-500/8',
  neutral: 'border-slate-700/70 bg-slate-900/40',
  negative: 'border-rose-500/25 bg-rose-500/8',
} as const

export default function ExplainableScore({ explanation, isMonitoring }: Props) {
  return (
    <div className="bg-slate-800/50 border border-slate-700/50 rounded-2xl p-5 h-full">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-cyan-300/80 font-semibold mb-2">
            Why Your Score Changed
          </div>
          <h3 className="text-lg font-semibold text-white">{explanation.title}</h3>
          <p className="text-sm text-slate-400 mt-1">
            {isMonitoring ? explanation.summary : 'Resume monitoring to see a live explanation of the posture score.'}
          </p>
        </div>
        <div className="px-3 py-1 rounded-full border border-white/10 bg-slate-900/70 text-[11px] text-slate-300">
          Personalized feedback
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
        {explanation.factors.map((factor) => (
          <div
            key={factor.label}
            className={`rounded-xl border p-4 ${impactStyles[factor.impact]}`}
          >
            <div className="text-[11px] uppercase tracking-[0.18em] text-slate-400 mb-2">{factor.label}</div>
            <p className="text-sm leading-6 text-slate-100">{factor.description}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="rounded-xl border border-slate-700/70 bg-slate-900/50 p-3">
          <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">What SitRight is seeing</div>
          <p className="text-sm text-slate-200">{explanation.primaryReason}</p>
        </div>
        <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3">
          <div className="text-[11px] uppercase tracking-wider text-cyan-300/70 mb-1">Best next step</div>
          <p className="text-sm text-cyan-100">{explanation.recommendation}</p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
        {explanation.insights.map((insight) => (
          <div
            key={insight}
            className="rounded-xl border border-slate-700/70 bg-slate-900/40 px-3 py-2 text-xs leading-5 text-slate-300"
          >
            {insight}
          </div>
        ))}
      </div>
    </div>
  )
}
