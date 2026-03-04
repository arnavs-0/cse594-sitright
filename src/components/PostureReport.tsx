import { PostureSnapshot } from '../types'

interface PostureReportProps {
  timeline: PostureSnapshot[]
}

export default function PostureReport({ timeline }: PostureReportProps) {
  if (timeline.length === 0) return null

  const total = timeline.length
  const goodCount = timeline.filter(s => s.status === 'good').length
  const warningCount = timeline.filter(s => s.status === 'warning').length
  const badCount = timeline.filter(s => s.status === 'bad').length

  const score = Math.round((goodCount / total) * 100)
  
  return (
    <div className="bg-slate-800/20 border border-white/5 rounded-3xl p-6 backdrop-blur-xl">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h3 className="text-xs font-black uppercase tracking-widest text-slate-500 mb-1">Clinical Analysis</h3>
          <h2 className="text-xl font-bold text-white">Posture Health Report</h2>
        </div>
        <div className="text-right">
          <div className="text-3xl font-black text-emerald-400">{score}%</div>
          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-tighter">Spinal Integrity Score</div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="bg-white/5 rounded-2xl p-4 border border-white/5">
          <div className="text-[10px] font-black text-emerald-500 uppercase mb-1">Optimal</div>
          <div className="text-xl font-bold text-white">{Math.round((goodCount/total)*100)}%</div>
          <div className="text-[9px] text-slate-500">Correct Alignment</div>
        </div>
        <div className="bg-white/5 rounded-2xl p-4 border border-white/5">
          <div className="text-[10px] font-black text-amber-500 uppercase mb-1">Warning</div>
          <div className="text-xl font-bold text-white">{Math.round((warningCount/total)*100)}%</div>
          <div className="text-[9px] text-slate-500">Early Deviation</div>
        </div>
        <div className="bg-white/5 rounded-2xl p-4 border border-white/5">
          <div className="text-[10px] font-black text-red-500 uppercase mb-1">Critical</div>
          <div className="text-xl font-bold text-white">{Math.round((badCount/total)*100)}%</div>
          <div className="text-[9px] text-slate-500">Structural Stress</div>
        </div>
      </div>

      <div className="space-y-4">
        <h4 className="text-[10px] font-black uppercase tracking-widest text-slate-500">Pathological Observations</h4>
        <div className="space-y-2">
          {badCount > goodCount / 2 && (
            <div className="flex items-center gap-3 p-3 bg-red-500/10 border border-red-500/20 rounded-xl">
              <div className="w-1.5 h-1.5 rounded-full bg-red-500" />
              <span className="text-[11px] text-red-200 font-medium">High frequency of Thoracic Kyphosis (Slouching) detected.</span>
            </div>
          )}
          {warningCount > total / 3 && (
            <div className="flex items-center gap-3 p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl">
              <div className="w-1.5 h-1.5 rounded-full bg-amber-500" />
              <span className="text-[11px] text-amber-200 font-medium">Significant "Text Neck" tendency observed. Reset baseline often.</span>
            </div>
          )}
          <div className="flex items-center gap-3 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span className="text-[11px] text-emerald-200 font-medium">Spinal decompression exercises recommended every 45 minutes.</span>
          </div>
        </div>
      </div>
    </div>
  )
}
