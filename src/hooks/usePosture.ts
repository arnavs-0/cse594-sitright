import { useState, useEffect, useCallback, useRef } from 'react'
import { PoseLandmarker, FilesetResolver, PoseLandmarkerResult } from '@mediapipe/tasks-vision'
import {
  PostureStatus,
  PostureAlert,
  PostureSnapshot,
  AlertMode,
  AppSettings,
  ScoreExplanation,
  ScoreExplanationFactor,
} from '../types'

const CAPTURE_MS = 2500
const MIN_CAPTURE_SAMPLES = 20
const BUFFER_SIZE = 10
const ISSUE_HISTORY_SIZE = 18
const EXPLANATION_UPDATE_MS = 1200
const EXPLANATION_ISSUE_WINDOW = 6

type NotificationFrequency = AppSettings['notificationFrequency']
type FeatureKey =
  | 'headLift'
  | 'forwardHead'
  | 'torsoLean'
  | 'shoulderTilt'
  | 'headTilt'
  | 'shoulderRelaxation'

type PoseFeatures = Record<FeatureKey, number>
type CalibrationProfile = {
  good: PoseFeatures
  bad: PoseFeatures
  warningThreshold: number
  badThreshold: number
}
type CaptureSample = {
  legacyMetric: number
  features: PoseFeatures
}
type IssueAnalysis = {
  key: FeatureKey
  label: string
  severity: number
  value: string
  description: string
}
type ExplanationSnapshot = {
  status: PostureStatus
  issue: FeatureKey | null
}

const FEATURE_WEIGHTS: Record<FeatureKey, number> = {
  headLift: 0.34,
  forwardHead: 0.24,
  torsoLean: 0.16,
  shoulderTilt: 0.1,
  headTilt: 0.08,
  shoulderRelaxation: 0.08,
}

const FEATURE_LABELS: Record<FeatureKey, string> = {
  headLift: 'Head lift',
  forwardHead: 'Forward head',
  torsoLean: 'Torso lean',
  shoulderTilt: 'Shoulder tilt',
  headTilt: 'Head tilt',
  shoulderRelaxation: 'Shoulder tension',
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

function getNotificationIntervalMs(frequency: NotificationFrequency): number {
  if (frequency === 'immediate') return 0
  if (frequency === '10sec') return 10 * 1000
  if (frequency === '30sec') return 30 * 1000
  return 5 * 60 * 1000
}

function randomMsg(status: PostureStatus): string {
  const msgs = POSTURE_MESSAGES[status]
  return msgs[Math.floor(Math.random() * msgs.length)]
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function clampPercent(value: number): number {
  return clamp(Math.round(value), 0, 100)
}

function averageFeature(samples: CaptureSample[], key: FeatureKey): number {
  if (samples.length === 0) return 0
  return samples.reduce((sum, sample) => sum + sample.features[key], 0) / samples.length
}

function averageLegacyMetric(samples: CaptureSample[]): number {
  if (samples.length === 0) return 0
  return samples.reduce((sum, sample) => sum + sample.legacyMetric, 0) / samples.length
}

function averagePoseFeatures(samples: CaptureSample[]): PoseFeatures {
  return {
    headLift: averageFeature(samples, 'headLift'),
    forwardHead: averageFeature(samples, 'forwardHead'),
    torsoLean: averageFeature(samples, 'torsoLean'),
    shoulderTilt: averageFeature(samples, 'shoulderTilt'),
    headTilt: averageFeature(samples, 'headTilt'),
    shoulderRelaxation: averageFeature(samples, 'shoulderRelaxation'),
  }
}

function blendFeatures(previous: PoseFeatures | null, next: PoseFeatures, weight = 0.2): PoseFeatures {
  if (!previous) return next
  return {
    headLift: previous.headLift * (1 - weight) + next.headLift * weight,
    forwardHead: previous.forwardHead * (1 - weight) + next.forwardHead * weight,
    torsoLean: previous.torsoLean * (1 - weight) + next.torsoLean * weight,
    shoulderTilt: previous.shoulderTilt * (1 - weight) + next.shoulderTilt * weight,
    headTilt: previous.headTilt * (1 - weight) + next.headTilt * weight,
    shoulderRelaxation: previous.shoulderRelaxation * (1 - weight) + next.shoulderRelaxation * weight,
  }
}

function createInitialExplanation(): ScoreExplanation {
  return {
    title: 'Explainability waiting for calibration',
    summary: 'Capture your upright and slouched samples so SitRight can personalize its on-device posture model.',
    primaryReason: 'The live score uses multiple pose signals, but it needs your personal calibration before the feedback can become specific.',
    recommendation: 'Complete both calibration steps to unlock personalized feedback.',
    factors: [
      {
        label: 'Head lift',
        value: 'Waiting',
        impact: 'neutral',
        description: 'How high your head sits relative to your shoulders.',
      },
      {
        label: 'Forward head',
        value: 'Waiting',
        impact: 'neutral',
        description: 'How far your head has drifted in front of your shoulder line.',
      },
      {
        label: 'Torso lean',
        value: 'Waiting',
        impact: 'neutral',
        description: 'How centered your upper body is over your hips.',
      },
      {
        label: 'Calibration',
        value: 'Needed',
        impact: 'neutral',
        description: 'Good and bad samples define your personal posture ranges.',
      },
    ],
    insights: [
      'The score will be based on multiple pose signals, not one generic metric.',
      'Feedback is generated locally from your camera landmarks to keep latency low.',
    ],
  }
}

function computePoseFeatures(landmarks: PoseLandmarkerResult['landmarks'][number]): {
  legacyMetric: number
  features: PoseFeatures
} | null {
  const nose = landmarks[0]
  const leftEar = landmarks[7]
  const rightEar = landmarks[8]
  const leftShoulder = landmarks[11]
  const rightShoulder = landmarks[12]
  const leftHip = landmarks[23]
  const rightHip = landmarks[24]

  if (!nose || !leftEar || !rightEar || !leftShoulder || !rightShoulder || !leftHip || !rightHip) {
    return null
  }

  const shoulderWidth = Math.hypot(leftShoulder.x - rightShoulder.x, leftShoulder.y - rightShoulder.y)
  const hipWidth = Math.hypot(leftHip.x - rightHip.x, leftHip.y - rightHip.y)
  const bodyScale = Math.max(0.0001, shoulderWidth, hipWidth)

  const shoulderMidX = (leftShoulder.x + rightShoulder.x) / 2
  const shoulderMidY = (leftShoulder.y + rightShoulder.y) / 2
  const earMidX = (leftEar.x + rightEar.x) / 2
  const earMidY = (leftEar.y + rightEar.y) / 2
  const hipMidX = (leftHip.x + rightHip.x) / 2
  const hipMidY = (leftHip.y + rightHip.y) / 2

  const headLift = clamp((shoulderMidY - nose.y) / bodyScale, 0, 3)
  const forwardHead = Math.abs(earMidX - shoulderMidX) / bodyScale
  const torsoLean = Math.abs(shoulderMidX - hipMidX) / bodyScale
  const shoulderTilt = Math.abs(leftShoulder.y - rightShoulder.y) / bodyScale
  const headTilt = Math.abs(leftEar.y - rightEar.y) / bodyScale
  const shoulderRelaxation = clamp(((leftShoulder.y - leftEar.y) + (rightShoulder.y - rightEar.y)) / 2 / bodyScale, 0, 2)
  const legacyMetric = (shoulderMidY - nose.y) / bodyScale

  if (!Number.isFinite(headLift) || headLift <= 0) {
    return null
  }

  return {
    legacyMetric,
    features: {
      headLift,
      forwardHead,
      torsoLean,
      shoulderTilt,
      headTilt,
      shoulderRelaxation,
    },
  }
}

function severityForFeature(current: number, good: number, bad: number, higherIsBetter: boolean): number {
  const direction = higherIsBetter ? -1 : 1
  const adjustedCurrent = current * direction
  const adjustedGood = good * direction
  const adjustedBad = bad * direction
  const range = Math.max(0.02, adjustedBad - adjustedGood)
  return clamp((adjustedCurrent - adjustedGood) / range, 0, 1.15)
}

function buildIssueAnalyses(current: PoseFeatures, profile: CalibrationProfile): IssueAnalysis[] {
  const severities: Record<FeatureKey, number> = {
    headLift: severityForFeature(current.headLift, profile.good.headLift, profile.bad.headLift, true),
    forwardHead: severityForFeature(current.forwardHead, profile.good.forwardHead, profile.bad.forwardHead, false),
    torsoLean: severityForFeature(current.torsoLean, profile.good.torsoLean, profile.bad.torsoLean, false),
    shoulderTilt: severityForFeature(current.shoulderTilt, profile.good.shoulderTilt, profile.bad.shoulderTilt, false),
    headTilt: severityForFeature(current.headTilt, profile.good.headTilt, profile.bad.headTilt, false),
    shoulderRelaxation: severityForFeature(
      current.shoulderRelaxation,
      profile.good.shoulderRelaxation,
      profile.bad.shoulderRelaxation,
      true,
    ),
  }

  return (Object.keys(FEATURE_WEIGHTS) as FeatureKey[]).map((key) => {
    const currentValue = current[key]
    const personalizedDelta =
      key === 'headLift' || key === 'shoulderRelaxation'
        ? currentValue - profile.good[key]
        : profile.good[key] - currentValue

    let value = ''
    let description = ''

    if (key === 'headLift') {
      value = `${clampPercent((currentValue / Math.max(profile.good.headLift, 0.01)) * 100)}%`
      description =
        personalizedDelta >= 0
          ? 'Head height is close to or above your calibrated upright position.'
          : 'Your head is sitting lower than your upright baseline, which usually means slouching.'
    } else if (key === 'forwardHead') {
      value = `${(currentValue * 100).toFixed(1)}`
      description =
        currentValue <= profile.good.forwardHead
          ? 'Head remains close to your shoulder line.'
          : 'Your head has drifted forward relative to your personal baseline.'
    } else if (key === 'torsoLean') {
      value = `${(currentValue * 100).toFixed(1)}`
      description =
        currentValue <= profile.good.torsoLean
          ? 'Torso is centered well over your hips.'
          : 'Upper body is leaning off center, which can pull the score down.'
    } else if (key === 'shoulderTilt') {
      value = `${(currentValue * 100).toFixed(1)}`
      description =
        currentValue <= profile.good.shoulderTilt
          ? 'Shoulders are level.'
          : 'One shoulder is sitting higher than the other.'
    } else if (key === 'headTilt') {
      value = `${(currentValue * 100).toFixed(1)}`
      description =
        currentValue <= profile.good.headTilt
          ? 'Head is level.'
          : 'Head tilt suggests screen or seating asymmetry.'
    } else {
      value = `${clampPercent((currentValue / Math.max(profile.good.shoulderRelaxation, 0.01)) * 100)}%`
      description =
        currentValue >= profile.good.shoulderRelaxation
          ? 'Shoulders look relaxed relative to your baseline.'
          : 'Reduced neck-to-shoulder space suggests some shoulder tension.'
    }

    return {
      key,
      label: FEATURE_LABELS[key],
      severity: severities[key],
      value,
      description,
    }
  })
}

function getTopRecurringIssue(issueHistory: FeatureKey[]): FeatureKey | null {
  if (issueHistory.length === 0) return null
  const counts = new Map<FeatureKey, number>()
  for (const issue of issueHistory) {
    counts.set(issue, (counts.get(issue) ?? 0) + 1)
  }
  let winner: FeatureKey | null = null
  let bestCount = -1
  for (const [issue, count] of counts.entries()) {
    if (count > bestCount) {
      winner = issue
      bestCount = count
    }
  }
  return winner
}

function getStableIssue(issueHistory: Array<FeatureKey | null>): FeatureKey | null {
  if (issueHistory.length < 3) return null
  const recent = issueHistory.slice(-EXPLANATION_ISSUE_WINDOW).filter((issue): issue is FeatureKey => issue !== null)
  if (recent.length < 3) return null
  const candidate = getTopRecurringIssue(recent)
  if (!candidate) return null
  const count = recent.filter((issue) => issue === candidate).length
  return count >= 3 ? candidate : null
}

function recommendationForIssues(status: PostureStatus, topIssues: IssueAnalysis[]): string {
  const issueKeys = topIssues.map((issue) => issue.key)
  if (issueKeys.includes('forwardHead') || issueKeys.includes('headLift')) {
    return 'Bring your chin slightly back and think about stacking your ears over your shoulders.'
  }
  if (issueKeys.includes('torsoLean')) {
    return 'Shift your ribcage back over your hips and reset against the back of your chair if you can.'
  }
  if (issueKeys.includes('shoulderRelaxation')) {
    return 'Drop your shoulders, unclench, and let your neck lengthen before checking the score again.'
  }
  if (issueKeys.includes('shoulderTilt') || issueKeys.includes('headTilt')) {
    return 'Level your screen and sit evenly so your head and shoulders stop compensating to one side.'
  }
  if (status === 'good') {
    return 'Stay with this posture. The model sees stable alignment across several frames.'
  }
  return 'Make one small reset first, then let the score settle for a second.'
}

function getIssueCoachLabel(issue: FeatureKey): string {
  if (issue === 'forwardHead' || issue === 'headLift') return 'Head and neck position'
  if (issue === 'torsoLean') return 'Upper-body balance'
  if (issue === 'shoulderRelaxation') return 'Shoulder tension'
  if (issue === 'shoulderTilt' || issue === 'headTilt') return 'Left-right balance'
  return FEATURE_LABELS[issue]
}

function getIssueUserMessage(issue: FeatureKey, status: PostureStatus): string {
  if (issue === 'forwardHead' || issue === 'headLift') {
    return status === 'good'
      ? 'Your head is staying nicely stacked over your shoulders.'
      : 'Your head is starting to creep forward compared with your usual upright posture.'
  }
  if (issue === 'torsoLean') {
    return status === 'good'
      ? 'Your upper body is staying centered instead of drifting forward.'
      : 'Your upper body has drifted away from its usual centered position.'
  }
  if (issue === 'shoulderRelaxation') {
    return status === 'good'
      ? 'Your shoulders look relaxed and not bunched up.'
      : 'Your shoulders look a bit tense or lifted, which often happens when posture slips.'
  }
  return status === 'good'
    ? 'You look balanced from left to right.'
    : 'You look slightly uneven from left to right, which may come from screen or seating setup.'
}

function getIssueWhyMessage(issue: FeatureKey, status: PostureStatus): string {
  if (issue === 'forwardHead' || issue === 'headLift') {
    return status === 'good'
      ? 'Compared with your calibration, your head position still matches your stronger posture.'
      : 'Compared with your own calibration, this looks more like your slouched pattern than your best posture.'
  }
  if (issue === 'torsoLean') {
    return status === 'good'
      ? 'Your torso is still lining up with your good-posture sample.'
      : 'SitRight is seeing the same forward drift that showed up in your bad-posture sample.'
  }
  if (issue === 'shoulderRelaxation') {
    return status === 'good'
      ? 'Your shoulders are staying relaxed relative to your personal baseline.'
      : 'Your shoulders are more raised than they were in your upright baseline.'
  }
  return status === 'good'
    ? 'Your alignment still matches your more balanced baseline.'
    : 'This asymmetry is stronger than it was in your upright baseline.'
}

function createExplanation(
  status: PostureStatus,
  score: number,
  _rawScore: number,
  confidence: number,
  profile: CalibrationProfile,
  currentFeatures: PoseFeatures,
  topIssueHistory: FeatureKey | null,
): ScoreExplanation {
  const issues = buildIssueAnalyses(currentFeatures, profile).sort((a, b) => b.severity - a.severity)
  const topIssues = issues.slice(0, 3)
  const dominant = topIssues[0]
  const secondary = topIssues[1]
  const recurringIssueLabel = topIssueHistory ? FEATURE_LABELS[topIssueHistory] : null

  const factors: ScoreExplanationFactor[] = [
    {
      label: 'What changed',
      value: '',
      impact: status === 'good' ? 'positive' : dominant.severity >= 0.7 ? 'negative' : 'neutral',
      description: getIssueUserMessage(dominant.key, status),
    },
    {
      label: 'Why SitRight thinks that',
      value: '',
      impact: 'neutral',
      description: getIssueWhyMessage(dominant.key, status),
    },
    {
      label: 'What to adjust',
      value: '',
      impact: status === 'good' ? 'positive' : 'neutral',
      description: recommendationForIssues(status, topIssues),
    },
  ]

  if (secondary && secondary.severity >= 0.4 && secondary.key !== dominant.key) {
    factors.push({
      label: 'Also noticing',
      value: '',
      impact: secondary.severity >= 0.7 ? 'negative' : 'neutral',
      description: getIssueUserMessage(secondary.key, status === 'good' ? 'warning' : status),
    })
  }

  const title =
    status === 'good'
      ? 'Your posture looks steady right now'
      : status === 'warning'
        ? `${getIssueCoachLabel(dominant.key)} is starting to slip`
        : `${getIssueCoachLabel(dominant.key)} is pulling your score down`

  const insights = [
    recurringIssueLabel
      ? `This seems to be your most common posture pattern in this session: ${recurringIssueLabel.toLowerCase()}.`
      : 'SitRight is comparing your current posture with the good and bad samples you recorded earlier.',
    status === 'good'
      ? 'Right now you are staying closer to your upright calibration than your slouched calibration.'
      : 'Right now you are drifting closer to your slouched calibration than your upright calibration.',
    confidence >= 85
      ? 'The camera has a clear enough view to make this feedback reliable.'
      : 'Camera visibility is limited, so this feedback may be less certain.',
  ]

  const summary =
    status === 'good'
      ? 'You are staying close to the posture you showed during your upright calibration.'
      : `SitRight is mainly seeing a change in ${getIssueCoachLabel(dominant.key).toLowerCase()}, so the score has dropped.`

  const primaryReason =
    status === 'good'
      ? 'Your posture currently looks more like your personal good-posture sample than your slouched sample.'
      : `${getIssueCoachLabel(dominant.key)} currently looks closer to your slouched sample than to your upright sample.`

  return {
    title,
    summary,
    primaryReason,
    recommendation: recommendationForIssues(status, topIssues),
    factors,
    insights,
  }
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
  const [explanation, setExplanation] = useState<ScoreExplanation>(createInitialExplanation)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const landmarkerRef = useRef<PoseLandmarker | null>(null)
  const lastVideoTimeRef = useRef(-1)
  const requestRef = useRef<number>()
  const baselineRef = useRef<number | null>(null)
  const calibrationTargetRef = useRef<'good' | 'bad' | null>(null)
  const calibrationStartTimeRef = useRef(0)
  const calibrationSamplesRef = useRef<CaptureSample[]>([])
  const calibrationProfileRef = useRef<CalibrationProfile | null>(null)
  const goodCalibrationSamplesRef = useRef<CaptureSample[]>([])
  const issueHistoryRef = useRef<FeatureKey[]>([])
  const explanationIssueHistoryRef = useRef<Array<FeatureKey | null>>([])
  const smoothedFeatureRef = useRef<PoseFeatures | null>(null)
  const explanationRef = useRef<ExplanationSnapshot>({ status: 'good', issue: null })
  const lastExplanationUpdateRef = useRef(0)
  const lastAlertTimeRef = useRef(0)
  const lastBannerTimeRef = useRef(0)
  const lastReportedStatusRef = useRef<PostureStatus>('good')
  const statusHistoryRef = useRef<PostureStatus[]>([])
  const smoothedScoreRef = useRef(100)

  useEffect(() => {
    async function initMediaPipe() {
      try {
        const vision = await FilesetResolver.forVisionTasks('/wasm')
        const poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: '/models/pose_landmarker_lite.task',
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numPoses: 1,
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
    calibrationTargetRef.current = null
    calibrationSamplesRef.current = []
    goodCalibrationSamplesRef.current = []
    issueHistoryRef.current = []
    explanationIssueHistoryRef.current = []
    smoothedFeatureRef.current = null
    explanationRef.current = { status: 'good', issue: null }
    lastExplanationUpdateRef.current = 0
    statusHistoryRef.current = []
    smoothedScoreRef.current = 100
    setCalibrationProgress(0)
    setIsCapturingCalibration(false)
    setCalibrationStep('good')
    setStatus('good')
    setScore(100)
    setConfidence(0)
    setExplanation(createInitialExplanation())
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
      setExplanation((prev) => ({
        ...prev,
        title: 'Pose not visible enough',
        summary: 'The on-device model cannot reliably explain the score until your head, shoulders, and hips are visible again.',
        primaryReason: 'Landmark visibility dropped too low for personalized posture analysis.',
        recommendation: 'Move back into frame and keep your upper body centered.',
        factors: prev.factors.map((factor) =>
          factor.label === 'Calibration'
            ? factor
            : {
                ...factor,
                impact: 'neutral',
              }
        ),
        insights: [
          'Head, shoulder, and hip landmarks are all needed for the richer real-time explanation.',
          'When those landmarks return, the personalized scoring model will resume immediately.',
        ],
      }))
      return
    }

    const pose = computePoseFeatures(result.landmarks[0])
    if (!pose) return

    const detectedConfidence = 95
    setConfidence(detectedConfidence)
    baselineRef.current = baselineRef.current ?? pose.legacyMetric

    if (isCapturingCalibration && calibrationTargetRef.current) {
      calibrationSamplesRef.current.push(pose)
      const elapsed = performance.now() - calibrationStartTimeRef.current
      const progress = Math.min(100, (elapsed / CAPTURE_MS) * 100)
      setCalibrationProgress(progress)

      if (elapsed >= CAPTURE_MS) {
        const samples = calibrationSamplesRef.current
        const target = calibrationTargetRef.current
        const averageMetric = averageLegacyMetric(samples)

        setIsCapturingCalibration(false)
        calibrationTargetRef.current = null
        calibrationSamplesRef.current = []

        if (samples.length < MIN_CAPTURE_SAMPLES || averageMetric <= 0) {
          setCalibrationProgress(0)
          return
        }

        if (target === 'good') {
          goodCalibrationSamplesRef.current = samples
          baselineRef.current = averageMetric
          setCalibrationProgress(0)
          setCalibrationStep('bad')
        } else {
          const goodSamples = goodCalibrationSamplesRef.current
          const goodMetric = averageLegacyMetric(goodSamples)
          const badMetric = averageMetric
          const safeGoodMetric = Math.max(goodMetric, badMetric + 0.01)
          const observedBadRatio = clamp(badMetric / safeGoodMetric, 0.45, 0.9)
          const warningRatio = Math.max(observedBadRatio + 0.08, Math.min(0.95, observedBadRatio + 0.18))

          calibrationProfileRef.current = {
            good: averagePoseFeatures(goodSamples),
            bad: averagePoseFeatures(samples),
            warningThreshold: warningRatio,
            badThreshold: observedBadRatio,
          }

          baselineRef.current = safeGoodMetric
          issueHistoryRef.current = []
          explanationIssueHistoryRef.current = []
          smoothedFeatureRef.current = pose.features
          explanationRef.current = { status: 'good', issue: null }
          lastExplanationUpdateRef.current = Date.now()
          statusHistoryRef.current = []
          smoothedScoreRef.current = 100
          lastReportedStatusRef.current = 'good'
          setStatus('good')
          setScore(100)
          setCalibrationProgress(100)
          setCalibrationStep('done')
          setExplanation(createExplanation('good', 100, 100, detectedConfidence, calibrationProfileRef.current, pose.features, null))
          window.electronAPI?.hideOverlay()
        }
      }

      return
    }

    if (calibrationStep !== 'done' || !calibrationProfileRef.current || !baselineRef.current) {
      return
    }

    const profile = calibrationProfileRef.current
    const ratio = pose.legacyMetric / baselineRef.current
    const issues = buildIssueAnalyses(pose.features, profile).sort((a, b) => b.severity - a.severity)
    const weightedPenalty = issues.reduce((sum, issue) => sum + issue.severity * FEATURE_WEIGHTS[issue.key], 0)
    const featureScore = clampPercent((1 - clamp(weightedPenalty, 0, 1)) * 100)
    const legacyScore = clampPercent(((ratio - profile.badThreshold) / (1 - profile.badThreshold)) * 100)
    const rawScore = clampPercent(featureScore * 0.75 + legacyScore * 0.25)

    let rawStatus: PostureStatus = 'good'
    if (ratio < profile.badThreshold || rawScore < 50) {
      rawStatus = 'bad'
    } else if (ratio < profile.warningThreshold || rawScore < 75) {
      rawStatus = 'warning'
    }

    smoothedScoreRef.current = smoothedScoreRef.current * 0.7 + rawScore * 0.3
    const finalScore = Math.round(smoothedScoreRef.current)
    setScore(finalScore)

    statusHistoryRef.current.push(rawStatus)
    if (statusHistoryRef.current.length > BUFFER_SIZE) {
      statusHistoryRef.current.shift()
    }

    const dominantIssue = issues[0]?.key
    if (dominantIssue && issues[0].severity >= 0.35) {
      issueHistoryRef.current.push(dominantIssue)
      if (issueHistoryRef.current.length > ISSUE_HISTORY_SIZE) {
        issueHistoryRef.current.shift()
      }
    }
    explanationIssueHistoryRef.current.push(dominantIssue && issues[0].severity >= 0.45 ? dominantIssue : null)
    if (explanationIssueHistoryRef.current.length > EXPLANATION_ISSUE_WINDOW) {
      explanationIssueHistoryRef.current.shift()
    }

    const lastThree = statusHistoryRef.current.slice(-3)
    const allBad = lastThree.length === 3 && lastThree.every((value) => value === 'bad')
    const allPoor = lastThree.length === 3 && lastThree.every((value) => value === 'warning' || value === 'bad')

    let newStatus: PostureStatus = status
    if (allBad) {
      newStatus = 'bad'
    } else if (allPoor && status !== 'bad') {
      newStatus = 'warning'
    } else if (statusHistoryRef.current.every((value) => value === 'good')) {
      newStatus = 'good'
    }

    if (newStatus !== status) {
      setStatus(newStatus)
    }

    smoothedFeatureRef.current = blendFeatures(smoothedFeatureRef.current, pose.features)
    const stableIssue = getStableIssue(explanationIssueHistoryRef.current)
    const now = Date.now()
    const explanationChanged =
      explanationRef.current.status !== newStatus || explanationRef.current.issue !== stableIssue
    const explanationDue = now - lastExplanationUpdateRef.current >= EXPLANATION_UPDATE_MS

    if (explanationChanged || explanationDue) {
      setExplanation(
        createExplanation(
          newStatus,
          finalScore,
          rawScore,
          detectedConfidence,
          profile,
          smoothedFeatureRef.current ?? pose.features,
          stableIssue ?? getTopRecurringIssue(issueHistoryRef.current),
        ),
      )
      explanationRef.current = { status: newStatus, issue: stableIssue }
      lastExplanationUpdateRef.current = now
    }

    if (newStatus !== lastReportedStatusRef.current) {
      if (newStatus === 'good') {
        window.electronAPI?.hideOverlay()
      } else if (alertMode === 'overlay' || alertMode === 'both') {
        window.electronAPI?.showOverlay(newStatus)
      }
      lastReportedStatusRef.current = newStatus
    }

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

    if (newStatus !== 'good' && window.electronAPI && (alertMode === 'banner' || alertMode === 'both')) {
      const now = Date.now()
      const cooldownMs = getNotificationIntervalMs(notificationFrequency)
      const statusChanged = newStatus !== lastReportedStatusRef.current
      const cooldownElapsed = cooldownMs === 0 || now - lastBannerTimeRef.current >= cooldownMs

      if (statusChanged || cooldownElapsed) {
        const body =
          newStatus === 'bad'
            ? 'Personalized posture model detected sustained drift. Sit back and reset your shoulders.'
            : 'Posture drift detected. Make a small adjustment and let the score settle.'
        window.electronAPI.sendNotification('SitRight — Posture Alert', body)
        lastBannerTimeRef.current = now
      }
    }
  }, [alertMode, calibrationStep, confidence, isCapturingCalibration, notificationFrequency, status])

  const detect = useCallback(() => {
    if (videoRef.current && isMonitoring && landmarkerRef.current) {
      const video = videoRef.current
      if (video.readyState >= 2 && video.currentTime !== lastVideoTimeRef.current) {
        lastVideoTimeRef.current = video.currentTime
        try {
          const result = landmarkerRef.current.detectForVideo(video, performance.now())
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
    explanation,
    toggleMonitoring: () => setIsMonitoring((prev) => !prev),
    setVideo: (video: HTMLVideoElement | null) => {
      videoRef.current = video
    },
    recalibrate: resetCalibration,
    captureGoodPosture,
    captureBadPosture,
  }
}
