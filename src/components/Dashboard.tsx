import PostureIndicator from './PostureIndicator'
import SessionStats from './SessionStats'
import PostureTimeline from './PostureTimeline'
import AlertHistory from './AlertHistory'
import CameraFeed from './CameraFeed'
import CalibrationPanel from './CalibrationPanel'
import ExplainableScore from './ExplainableScore'
import { PostureStatus, PostureAlert, PostureSnapshot, ScoreExplanation, SessionSummary } from '../types'
import { useSettings } from '../hooks/useSettings'
import { Landmark3D } from '../hooks/usePosture'

interface DashboardProps {
  posture: {
    status: PostureStatus
    score: number
    confidence: number
    landmarks3D: Landmark3D[]
    alerts: PostureAlert[]
    timeline: PostureSnapshot[]
    isMonitoring: boolean
    isSessionActive: boolean
    sessionStart: Date | null
    sessionTimeline: PostureSnapshot[]
    sessionAlerts: PostureAlert[]
    lastSessionSummary: SessionSummary | null
    startSession: () => void
    stopSession: () => void
    recalibrate: () => void
    calibrationStep: 'good' | 'bad' | 'done'
    isCapturingCalibration: boolean
    calibrationProgress: number
    captureGoodPosture: () => void
    captureBadPosture: () => void
    explanation: ScoreExplanation
  }
  setVideo: (video: HTMLVideoElement | null) => void
}

export default function Dashboard({ posture, setVideo }: DashboardProps) {
  const { settings, update } = useSettings()

  return (
    <div className="space-y-6">
      <CalibrationPanel
        calibrationStep={posture.calibrationStep}
        isCapturingCalibration={posture.isCapturingCalibration}
        calibrationProgress={posture.calibrationProgress}
        onCaptureGood={posture.captureGoodPosture}
        onCaptureBad={posture.captureBadPosture}
      />

      {/* Top row — posture ring + camera feed + stat cards */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-6">
          <PostureIndicator
            status={posture.status}
            score={posture.score}
            confidence={posture.confidence}
            isMonitoring={posture.isMonitoring}
          />
          <CameraFeed 
            landmarks3D={posture.landmarks3D}
            onVideoRef={setVideo} 
            isMonitoring={posture.isMonitoring} 
            status={posture.status}
            score={posture.score}
            selectedDeviceId={settings.deviceId}
            onDeviceChange={(id) => update('deviceId', id)}
            onRecalibrate={posture.recalibrate}
          />
        </div>
        <div className="lg:col-span-2">
          <SessionStats
            sessionStart={posture.sessionStart}
            status={posture.status}
            score={posture.score}
            alertCount={posture.alerts.length}
            isMonitoring={posture.isMonitoring}
            isSessionActive={posture.isSessionActive}
            sessionTimeline={posture.sessionTimeline}
            sessionAlerts={posture.sessionAlerts}
            lastSessionSummary={posture.lastSessionSummary}
            overlayEnabled={settings.overlayEnabled}
            onOverlayEnabledChange={(enabled) => update('overlayEnabled', enabled)}
            onStartSession={posture.startSession}
            onStopSession={posture.stopSession}
          />
        </div>
      </div>

      <ExplainableScore
        explanation={posture.explanation}
        isMonitoring={posture.isMonitoring}
      />

      {/* Timeline bar chart */}
      <PostureTimeline timeline={posture.timeline} />

      {/* Recent alerts */}
      <AlertHistory alerts={posture.alerts} />
    </div>
  )
}
