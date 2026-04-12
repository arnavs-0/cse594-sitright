import { useState, useEffect, useCallback, useRef } from 'react'
import { PoseLandmarker, FilesetResolver, PoseLandmarkerResult } from '@mediapipe/tasks-vision'
import { PostureStatus, PostureAlert, PostureSnapshot, AlertMode, AppSettings } from '../types'

const CAPTURE_MS = 2500
const MIN_CAPTURE_SAMPLES = 20
type NotificationFrequency = AppSettings['notificationFrequency']

function getNotificationIntervalMs(frequency: NotificationFrequency): number {
  if (frequency === 'immediate') return 0
  if (frequency === '10sec') return 10 * 1000
  if (frequency === '30sec') return 30 * 1000
  return 5 * 60 * 1000
}

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

export function usePosture(
  alertMode: AlertMode = 'overlay',
  notificationFrequency: NotificationFrequency = 'immediate',
) {
  const [isMonitoring, setIsMonitoring] = useState(true)
  const [status, setStatus] = useState<PostureStatus>('good')
  const [score, setScore] = useState(100)
  const [confidence, setConfidence] = useState(0)
  const [alerts, setAlerts] = useState<PostureAlert[]>([])
  const [timeline, setTimeline] = useState<PostureSnapshot[]>([])
  const [sessionStart] = useState<Date>(new Date())
  const [calibrationStep, setCalibrationStep] = useState<'good' | 'bad' | 'done'>('good')
  const [isCapturingCalibration, setIsCapturingCalibration] = useState(false)
  const [calibrationProgress, setCalibrationProgress] = useState(0)
  
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const landmarkerRef = useRef<PoseLandmarker | null>(null)
  const lastVideoTimeRef = useRef(-1)
  const requestRef = useRef<number>()
  const baselineRef = useRef<number | null>(null)
  const calibrationTargetRef = useRef<'good' | 'bad' | null>(null)
  const calibrationStartTimeRef = useRef(0)
  const calibrationSamplesRef = useRef<number[]>([])
  const goodCalibrationMetricRef = useRef<number | null>(null)
  const latestMetricRef = useRef<number | null>(null)
  const calibrationProfileRef = useRef<{ goodMetric: number; badRatio: number; warningRatio: number } | null>(null)
  const lastAlertTimeRef = useRef(0)
  const lastBannerTimeRef = useRef(0)
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

  const resetCalibration = useCallback(() => {
    baselineRef.current = null
    calibrationProfileRef.current = null
    goodCalibrationMetricRef.current = null
    calibrationTargetRef.current = null
    calibrationSamplesRef.current = []
    setCalibrationProgress(0)
    setIsCapturingCalibration(false)
    setCalibrationStep('good')
    statusHistoryRef.current = []
    smoothedScoreRef.current = 100
    setStatus('good')
    setScore(100)
    window.electronAPI?.hideOverlay()
  }, [])

  const startCapture = useCallback((target: 'good' | 'bad') => {
    if (isCapturingCalibration) return
    calibrationTargetRef.current = target
    calibrationStartTimeRef.current = performance.now()
    calibrationSamplesRef.current = []
    setCalibrationProgress(0)
    setIsCapturingCalibration(true)
  }, [isCapturingCalibration])

  const captureGoodPosture = useCallback(() => {
    if (calibrationStep !== 'good') return
    startCapture('good')
  }, [calibrationStep, startCapture])

  const captureBadPosture = useCallback(() => {
    if (calibrationStep !== 'bad') return
    startCapture('bad')
  }, [calibrationStep, startCapture])

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
    latestMetricRef.current = currentMetric

    if (isCapturingCalibration && calibrationTargetRef.current) {
      calibrationSamplesRef.current.push(currentMetric)
      const elapsed = performance.now() - calibrationStartTimeRef.current
      const progress = Math.min(100, (elapsed / CAPTURE_MS) * 100)
      setCalibrationProgress(progress)

      if (elapsed >= CAPTURE_MS) {
        const samples = calibrationSamplesRef.current
        const average =
          samples.length === 0 ? 0 : samples.reduce((sum, value) => sum + value, 0) / samples.length
        const target = calibrationTargetRef.current

        setIsCapturingCalibration(false)
        calibrationTargetRef.current = null
        calibrationSamplesRef.current = []

        if (samples.length < MIN_CAPTURE_SAMPLES || average <= 0) {
          setCalibrationProgress(0)
          return
        }

        if (target === 'good') {
          goodCalibrationMetricRef.current = average
          setCalibrationProgress(0)
          setCalibrationStep('bad')
        } else {
          const goodMetric = goodCalibrationMetricRef.current ?? average * 1.2
          const safeGoodMetric = Math.max(goodMetric, average + 0.01)
          const observedBadRatio = Math.max(0.45, Math.min(0.9, average / safeGoodMetric))
          const warningRatio = Math.max(observedBadRatio + 0.05, Math.min(0.95, observedBadRatio + 0.15))

          calibrationProfileRef.current = {
            goodMetric: safeGoodMetric,
            badRatio: observedBadRatio,
            warningRatio,
          }

          baselineRef.current = safeGoodMetric
          statusHistoryRef.current = []
          smoothedScoreRef.current = 100
          lastReportedStatusRef.current = 'good'
          setStatus('good')
          setScore(100)
          setCalibrationProgress(100)
          setCalibrationStep('done')
          window.electronAPI?.hideOverlay()
        }
      }

      return
    }

    if (calibrationStep !== 'done') {
      return
    }

    if (baselineRef.current === null && currentMetric > 0) {
      baselineRef.current = currentMetric
    }

    if (baselineRef.current) {
      const profile = calibrationProfileRef.current
      const ratio = profile
        ? currentMetric / profile.goodMetric
        : currentMetric / baselineRef.current
      
      let rawStatus: PostureStatus = 'good'
      let rawScore = Math.floor(ratio * 100)

      if (profile) {
        const normalizedScore = ((ratio - profile.badRatio) / (1 - profile.badRatio)) * 100
        rawScore = Math.max(0, Math.min(100, Math.round(normalizedScore)))
      }

      // INCREASED SENSITIVITY THRESHOLDS
      if (ratio < (profile?.badRatio ?? 0.75)) {
        rawStatus = 'bad'
      } else if (ratio < (profile?.warningRatio ?? 0.90)) {
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

      // Debounced alert history (for timeline/history cards)
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
        }
      }

      // Banner notifications use user-selected cadence and fire on warning/bad.
      if (newStatus !== 'good' && window.electronAPI && (alertMode === 'banner' || alertMode === 'both')) {
        const now = Date.now()
        const cooldownMs = getNotificationIntervalMs(notificationFrequency)
        const statusChanged = newStatus !== lastReportedStatusRef.current
        const cooldownElapsed = cooldownMs === 0 || now - lastBannerTimeRef.current >= cooldownMs

        if (statusChanged || cooldownElapsed) {
          const body =
            newStatus === 'bad'
              ? 'Poor posture detected. Sit up and reset your shoulders.'
              : 'Posture drift detected. Make a small adjustment.'
          window.electronAPI.sendNotification('SitRight — Posture Alert', body)
          lastBannerTimeRef.current = now
        }
      }
    }
  }, [alertMode, calibrationStep, confidence, isCapturingCalibration, notificationFrequency, status])

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
    calibrationStep,
    isCapturingCalibration,
    calibrationProgress,
    toggleMonitoring: () => setIsMonitoring((prev) => !prev),
    setVideo: (video: HTMLVideoElement | null) => { videoRef.current = video },
    recalibrate: resetCalibration,
    captureGoodPosture,
    captureBadPosture,
  }
}
