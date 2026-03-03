import { useState, useEffect, useCallback, useRef } from 'react'
import { PostureStatus, PostureAlert, PostureSnapshot, AlertMode } from '../types'

/* ============================================================
   INTEGRATION POINT FOR POSTURE TRACKING
   ============================================================
   This hook currently uses **simulated** posture data so the UI
   can be demonstrated independently of the CV model.

   To connect real posture detection, replace the `simulatePosture`
   callback with data from your detection pipeline.  The rest of
   the UI consumes the return value of this hook unchanged.
   ============================================================ */

const POSTURE_MESSAGES: Record<PostureStatus, string[]> = {
  good: ['Great posture!', 'Looking good!', 'Keep it up!'],
  warning: [
    'Slight forward lean detected',
    'Shoulders rising — try to relax them',
    'Head tilting — adjust your screen height',
  ],
  bad: [
    'Slouching detected — sit up straight',
    'Significant forward head posture',
    'Hunched shoulders — take a stretch break',
    'Poor posture detected — consider a break',
  ],
}

function randomMsg(status: PostureStatus): string {
  const msgs = POSTURE_MESSAGES[status]
  return msgs[Math.floor(Math.random() * msgs.length)]
}

export function usePosture(alertMode: AlertMode = 'overlay') {
  const [isMonitoring, setIsMonitoring] = useState(true)
  const [status, setStatus] = useState<PostureStatus>('good')
  const [score, setScore] = useState(92)
  const [confidence, setConfidence] = useState(95)
  const [alerts, setAlerts] = useState<PostureAlert[]>([])
  const [timeline, setTimeline] = useState<PostureSnapshot[]>([])
  const [sessionStart] = useState<Date>(new Date())
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  /* ---- simulated posture updates (REPLACE WITH REAL DETECTION) ---- */
  const simulatePosture = useCallback(() => {
    if (!isMonitoring) return

    // Weighted random: 60 % good · 25 % warning · 15 % bad
    const rand = Math.random()
    let newStatus: PostureStatus
    let newScore: number

    if (rand < 0.6) {
      newStatus = 'good'
      newScore = 75 + Math.floor(Math.random() * 25)
    } else if (rand < 0.85) {
      newStatus = 'warning'
      newScore = 45 + Math.floor(Math.random() * 30)
    } else {
      newStatus = 'bad'
      newScore = 10 + Math.floor(Math.random() * 35)
    }

    const newConfidence = 80 + Math.floor(Math.random() * 20)
    setStatus(newStatus)
    setScore(newScore)
    setConfidence(newConfidence)

    // Timeline
    setTimeline((prev) => [
      ...prev.slice(-59),
      { time: new Date(), status: newStatus, score: newScore },
    ])

    // Alerts for non-good posture
    if (newStatus !== 'good') {
      const alert: PostureAlert = {
        id: Date.now().toString(),
        timestamp: new Date(),
        type: newStatus,
        message: randomMsg(newStatus),
      }
      setAlerts((prev) => [alert, ...prev].slice(0, 50))

      // Screen-edge overlay glow (works even when app is minimized)
      if (alertMode === 'overlay' || alertMode === 'both') {
        window.electronAPI?.showOverlay(newStatus)
      }

      // Native desktop notification for bad posture
      if (newStatus === 'bad' && window.electronAPI && (alertMode === 'banner' || alertMode === 'both')) {
        window.electronAPI.sendNotification('SitRight — Posture Alert', alert.message)
      }
    } else {
      // Good posture — hide the overlay
      window.electronAPI?.hideOverlay()
    }
  }, [isMonitoring])

  useEffect(() => {
    if (isMonitoring) {
      simulatePosture()
      intervalRef.current = setInterval(simulatePosture, 8000)
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [isMonitoring, simulatePosture])

  const toggleMonitoring = useCallback(() => {
    setIsMonitoring((p) => {
      if (p) {
        // Pausing — immediately hide overlay
        window.electronAPI?.hideOverlay()
      }
      return !p
    })
  }, [])

  /* ---- keyboard shortcuts for live demos (Cmd/Ctrl + 1/2/3) ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key === '1') {
        setStatus('good')
        setScore(92)
        setConfidence(97)
        // Immediately clear the overlay
        window.electronAPI?.hideOverlay()
      } else if (e.key === '2') {
        setStatus('warning')
        setScore(55)
        setConfidence(88)
        if (alertMode === 'overlay' || alertMode === 'both') {
          window.electronAPI?.showOverlay('warning')
        }
      } else if (e.key === '3') {
        setStatus('bad')
        setScore(25)
        setConfidence(91)
        const alert: PostureAlert = {
          id: Date.now().toString(),
          timestamp: new Date(),
          type: 'bad',
          message: 'Poor posture detected. Try this: ',
        }
        setAlerts((prev) => [alert, ...prev].slice(0, 50))
        if (alertMode === 'overlay' || alertMode === 'both') {
          window.electronAPI?.showOverlay('bad')
        }
        if (alertMode === 'banner' || alertMode === 'both') {
          window.electronAPI?.sendNotification('SitRight — Posture Alert', alert.message)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [alertMode])

  return {
    status,
    score,
    confidence,
    alerts,
    timeline,
    isMonitoring,
    sessionStart,
    toggleMonitoring,
  }
}
