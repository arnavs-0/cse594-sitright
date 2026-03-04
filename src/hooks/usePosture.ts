import { useState, useEffect, useCallback, useRef } from 'react'
import { PoseLandmarker, FilesetResolver, PoseLandmarkerResult } from '@mediapipe/tasks-vision'
import { PostureStatus, PostureAlert, PostureSnapshot, AlertMode } from '../types'

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
  const [score, setScore] = useState(100)
  const [confidence, setConfidence] = useState(0)
  const [alerts, setAlerts] = useState<PostureAlert[]>([])
  const [timeline, setTimeline] = useState<PostureSnapshot[]>([])
  const [sessionStart] = useState<Date>(new Date())
  
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const landmarkerRef = useRef<PoseLandmarker | null>(null)
  const lastVideoTimeRef = useRef(-1)
  const requestRef = useRef<number>()
  const baselineRef = useRef<number | null>(null)
  const lastAlertTimeRef = useRef(0)
  const lastReportedStatusRef = useRef<PostureStatus>('good')

  /* ---- ASYMMETRIC SMOOTHING STATE ---- */
  const statusHistoryRef = useRef<PostureStatus[]>([])
  const smoothedScoreRef = useRef(100)
  const BUFFER_SIZE = 10 // Rolling window for "clearing" alerts

  // Initialize MediaPipe
  useEffect(() => {
    async function initMediaPipe() {
      try {
        const vision = await FilesetResolver.forVisionTasks(
          "/wasm"
        )
        const poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: "/models/pose_landmarker_lite.task",
            delegate: "GPU"
          },
          runningMode: "VIDEO",
          numPoses: 1
        })
        landmarkerRef.current = poseLandmarker
      } catch (err) {
        console.error('Failed to initialize MediaPipe:', err)
      }
    }
    initMediaPipe()
    
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current)
      landmarkerRef.current?.close()
    }
  }, [])

  const recalibrate = useCallback(() => {
    baselineRef.current = null
    statusHistoryRef.current = []
    smoothedScoreRef.current = 100
    console.log('Recalibrating baseline...')
  }, [])

  const processResult = useCallback((result: PoseLandmarkerResult) => {
    if (!result.landmarks || result.landmarks.length === 0) {
      if (confidence !== 0) setConfidence(0)
      return
    }

    const landmarks = result.landmarks[0]
    setConfidence(95)

    const nose = landmarks[0]
    const leftShoulder = landmarks[11]
    const rightShoulder = landmarks[12]

    const shoulderMidpointY = (leftShoulder.y + rightShoulder.y) / 2
    const shoulderWidth = Math.sqrt(
      Math.pow(leftShoulder.x - rightShoulder.x, 2) +
      Math.pow(leftShoulder.y - rightShoulder.y, 2)
    )

    const currentMetric = (shoulderMidpointY - nose.y) / shoulderWidth

    if (baselineRef.current === null && currentMetric > 0) {
      baselineRef.current = currentMetric
    }

    if (baselineRef.current) {
      const ratio = currentMetric / baselineRef.current
      
      let rawStatus: PostureStatus = 'good'
      let rawScore = Math.floor(ratio * 100)

      // INCREASED SENSITIVITY THRESHOLDS
      if (ratio < 0.75) {
        rawStatus = 'bad'
      } else if (ratio < 0.90) {
        rawStatus = 'warning'
      } else {
        rawStatus = 'good'
        rawScore = Math.min(100, rawScore)
      }

      /* ---- Faster Low-pass Filter on Score (30% weight to new) ---- */
      smoothedScoreRef.current = (smoothedScoreRef.current * 0.7) + (rawScore * 0.3)
      const finalScore = Math.round(smoothedScoreRef.current)
      setScore(finalScore)

      /* ---- Asymmetric Buffer Management ---- */
      statusHistoryRef.current.push(rawStatus)
      if (statusHistoryRef.current.length > BUFFER_SIZE) {
        statusHistoryRef.current.shift()
      }

      // FAST TRIGGER LOGIC:
      // If the last 3 frames are bad/warning, switch immediately.
      const lastThree = statusHistoryRef.current.slice(-3)
      const allBad = lastThree.length === 3 && lastThree.every(v => v === 'bad')
      const allPoor = lastThree.length === 3 && lastThree.every(v => v === 'warning' || v === 'bad')

      let newStatus: PostureStatus = status
      
      if (allBad) {
        newStatus = 'bad'
      } else if (allPoor && status !== 'bad') {
        newStatus = 'warning'
      } else if (statusHistoryRef.current.every(v => v === 'good')) {
        // SLOW CLEAR: Only go back to good if the entire buffer is good
        newStatus = 'good'
      }

      if (newStatus !== status) {
        setStatus(newStatus)
      }

      // REACTIVE OVERLAY CONTROL
      if (newStatus !== lastReportedStatusRef.current) {
        if (newStatus === 'good') {
          window.electronAPI?.hideOverlay()
        } else if (alertMode === 'overlay' || alertMode === 'both') {
          window.electronAPI?.showOverlay(newStatus)
        }
        lastReportedStatusRef.current = newStatus
      }

      // DEBOUNCED ALERTS
      if (newStatus !== 'good') {
        const now = Date.now()
        if (now - lastAlertTimeRef.current > 15000) {
          const alert: PostureAlert = {
            id: now.toString(),
            timestamp: new Date(),
            type: newStatus,
            message: randomMsg(newStatus),
          }
          setAlerts((prev) => [alert, ...prev].slice(0, 50))
          lastAlertTimeRef.current = now

          if (newStatus === 'bad' && window.electronAPI && (alertMode === 'banner' || alertMode === 'both')) {
            window.electronAPI.sendNotification('SitRight — Posture Alert', alert.message)
          }
        }
      }
    }
  }, [alertMode, confidence, status])

  const detect = useCallback(() => {
    if (videoRef.current && isMonitoring && landmarkerRef.current) {
      const video = videoRef.current
      if (video.readyState >= 2 && video.currentTime !== lastVideoTimeRef.current) {
        lastVideoTimeRef.current = video.currentTime
        try {
          const startTimeMs = performance.now()
          const result = landmarkerRef.current.detectForVideo(video, startTimeMs)
          processResult(result)
        } catch (err) {
          console.error('Detection error:', err)
        }
      }
    }
    requestRef.current = requestAnimationFrame(detect)
  }, [isMonitoring, processResult])

  useEffect(() => {
    if (isMonitoring) {
      requestRef.current = requestAnimationFrame(detect)
    } else {
      if (requestRef.current) cancelAnimationFrame(requestRef.current)
      window.electronAPI?.hideOverlay()
      lastReportedStatusRef.current = 'good'
      statusHistoryRef.current = []
    }
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current)
    }
  }, [isMonitoring, detect])

  useEffect(() => {
    const interval = setInterval(() => {
      if (!isMonitoring) return
      setTimeline((prev) => [
        ...prev.slice(-59),
        { time: new Date(), status, score },
      ])
    }, 10000)
    return () => clearInterval(interval)
  }, [isMonitoring, status, score])

  return {
    status,
    score,
    confidence,
    alerts,
    timeline,
    isMonitoring,
    sessionStart,
    toggleMonitoring: () => setIsMonitoring(!isMonitoring),
    setVideo: (video: HTMLVideoElement | null) => { videoRef.current = video },
    recalibrate,
  }
}
