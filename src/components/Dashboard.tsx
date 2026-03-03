import PostureIndicator from './PostureIndicator'
import SessionStats from './SessionStats'
import PostureTimeline from './PostureTimeline'
import AlertHistory from './AlertHistory'
import { PostureStatus, PostureAlert, PostureSnapshot } from '../types'

interface DashboardProps {
  posture: {
    status: PostureStatus
    score: number
    confidence: number
    alerts: PostureAlert[]
    timeline: PostureSnapshot[]
    isMonitoring: boolean
    sessionStart: Date
  }
}

export default function Dashboard({ posture }: DashboardProps) {
  return (
    <div className="space-y-6">
      {/* Top row — posture ring + stat cards */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1">
          <PostureIndicator
            status={posture.status}
            score={posture.score}
            confidence={posture.confidence}
            isMonitoring={posture.isMonitoring}
          />
        </div>
        <div className="lg:col-span-2">
          <SessionStats
            sessionStart={posture.sessionStart}
            score={posture.score}
            alertCount={posture.alerts.length}
            isMonitoring={posture.isMonitoring}
          />
        </div>
      </div>

      {/* Timeline bar chart */}
      <PostureTimeline timeline={posture.timeline} />

      {/* Recent alerts */}
      <AlertHistory alerts={posture.alerts} />
    </div>
  )
}
