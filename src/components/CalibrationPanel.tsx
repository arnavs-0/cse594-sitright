interface CalibrationPanelProps {
  calibrationStep: 'good' | 'bad' | 'done'
  isCapturingCalibration: boolean
  calibrationProgress: number
  onCaptureGood: () => void
  onCaptureBad: () => void
}

export default function CalibrationPanel({
  calibrationStep,
  isCapturingCalibration,
  calibrationProgress,
  onCaptureGood,
  onCaptureBad,
}: CalibrationPanelProps) {
  if (calibrationStep === 'done') return null

  const isGoodStep = calibrationStep === 'good'

  return (
    <div className="fixed inset-0 z-40 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-2xl p-6 shadow-2xl">
        <h2 className="text-lg font-semibold text-slate-100">Calibration</h2>
        <p className="text-sm text-slate-400 mt-1">
          {isGoodStep
            ? 'Step 1 of 2: Sit with your best posture and capture a sample.'
            : 'Step 2 of 2: Show your typical bad/slouched posture and capture a sample.'}
        </p>

        <div className="mt-4 bg-slate-800/70 border border-slate-700 rounded-xl p-4 text-sm text-slate-300">
          {isGoodStep
            ? 'Tip: Sit naturally upright with relaxed shoulders and your usual camera distance.'
            : 'Tip: Lean/slouch slightly like your common poor posture (no need to exaggerate).'}
        </div>

        {isCapturingCalibration && (
          <div className="mt-4">
            <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
              <span>Capturing sample...</span>
              <span>{Math.round(calibrationProgress)}%</span>
            </div>
            <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
              <div
                className="h-full bg-indigo-500 transition-all duration-150"
                style={{ width: `${calibrationProgress}%` }}
              />
            </div>
          </div>
        )}

        <div className="mt-6 flex items-center justify-end gap-2">
          {isGoodStep ? (
            <button
              onClick={onCaptureGood}
              disabled={isCapturingCalibration}
              className="px-4 py-2 rounded-lg bg-indigo-500 text-white text-sm font-medium disabled:opacity-50"
            >
              Capture Good Posture
            </button>
          ) : (
            <button
              onClick={onCaptureBad}
              disabled={isCapturingCalibration}
              className="px-4 py-2 rounded-lg bg-amber-500 text-slate-950 text-sm font-medium disabled:opacity-50"
            >
              Capture Bad Posture
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
