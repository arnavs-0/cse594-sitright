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

// ============================================================================
// 3D MODE
// Uncalibrated absolute-threshold classifier on MediaPipe worldLandmarks
// (metric 3D, origin at hip midpoint). +x right, +y down, +z away from camera.
// The whole point: measure forward head as ear-vs-shoulder DEPTH rather than
// lateral image-plane offset. This is the single feature with the largest
// accuracy gain for a frontal webcam.
// ============================================================================
// const USE_3D_MODE = true
const USE_3D_MODE = false

// Calibration-relative thresholds (degrees of deviation from upright baseline).
const HEAD_DEV_WARN_DEG = 3
const HEAD_DEV_BAD_DEG = 6
const SHOULDER_DEV_WARN_DEG = 3
const SHOULDER_DEV_BAD_DEG = 6

// Calibration capture window.
const CAPTURE_3D_MS = 1500
const CAPTURE_3D_MIN_SAMPLES = 20

// Visibility floor for a feature to be eligible for the classifier.
const VIS_MIN = 0.5

// Light EMA on the per-frame angles before classification.
const ANGLE_EMA_ALPHA = 0.25
const SCORE_EMA_ALPHA_3D = 0.30

// 2D-mode yaw threshold (degrees of body rotation away from facing-camera).
// At or above this, the 2D pixel-based features become unreliable and the
// score is driven by forwardHead alone — which is the 3D ear-angle metric.
const YAW_HIGH_DEG = 35

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
  bodyRotationDeg: number
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
  const shoulderMidZ = ((leftShoulder.z ?? 0) + (rightShoulder.z ?? 0)) / 2
  const earMidX = (leftEar.x + rightEar.x) / 2
  const earMidY = (leftEar.y + rightEar.y) / 2
  const earMidZ = ((leftEar.z ?? 0) + (rightEar.z ?? 0)) / 2
  const hipMidX = (leftHip.x + rightHip.x) / 2
  const hipMidY = (leftHip.y + rightHip.y) / 2

  const headLift = clamp((shoulderMidY - nose.y) / bodyScale, 0, 3)
  // forwardHead is now the 3D ear angle from vertical, in image coordinates.
  // Rotation-invariant about y, so chair-spinning leaves it ~unchanged. The
  // existing severityForFeature interpolates it between good/bad calibration
  // samples exactly the same way it does the other features. Killed: the old
  // |earMidX - shoulderMidX| / bodyScale lateral-offset version.
  const forwardHead = angleFromUp(earMidX, earMidY, earMidZ, shoulderMidX, shoulderMidY, shoulderMidZ)
  const torsoLean = Math.abs(shoulderMidX - hipMidX) / bodyScale
  const shoulderTilt = Math.abs(leftShoulder.y - rightShoulder.y) / bodyScale
  const headTilt = Math.abs(leftEar.y - rightEar.y) / bodyScale
  const shoulderRelaxation = clamp(((leftShoulder.y - leftEar.y) + (rightShoulder.y - rightEar.y)) / 2 / bodyScale, 0, 2)
  const legacyMetric = (shoulderMidY - nose.y) / bodyScale

  // Body yaw from facing-camera. atan2(|dz|, |dx|) on the shoulder line:
  // 0° = shoulders separated entirely in image-x (facing camera), 90° =
  // entirely in image-z (profile). The 2D pixel features become unreliable
  // as this grows; processResult uses it to fall back to forwardHead-only
  // scoring above YAW_HIGH_DEG.
  const shDx = leftShoulder.x - rightShoulder.x
  const shDz = (leftShoulder.z ?? 0) - (rightShoulder.z ?? 0)
  const bodyRotationDeg =
    Math.atan2(Math.abs(shDz), Math.abs(shDx)) * (180 / Math.PI)

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
    bodyRotationDeg,
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
  // forwardHead is special: it's the 3D ear angle in degrees, and its
  // severity is computed as deviation-from-upright against absolute degree
  // thresholds (HEAD_DEV_WARN_DEG / HEAD_DEV_BAD_DEG), NOT as interpolation
  // between good and bad calibration. profile.bad.forwardHead is recorded by
  // the bad-capture step but deliberately ignored here so the user doesn't
  // have to deliberately produce a bad forward-head pose during calibration.
  const fwdDev = current.forwardHead - profile.good.forwardHead
  const fwdRange = Math.max(0.02, HEAD_DEV_BAD_DEG - HEAD_DEV_WARN_DEG)
  const fwdSeverity = clamp((fwdDev - HEAD_DEV_WARN_DEG) / fwdRange, 0, 1.15)

  const severities: Record<FeatureKey, number> = {
    headLift: severityForFeature(current.headLift, profile.good.headLift, profile.bad.headLift, true),
    forwardHead: fwdSeverity,
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

export type Metrics3D = {
  // Per-frame absolute angles. All four are invariant under rotation about
  // the y axis (chair-spinning), so they can be calibrated once and compared
  // across any subsequent body rotation.
  ear_angle_deg: number       // angle of (ear_mid  - sh_mid) from -y (up)
  nose_angle_deg: number      // angle of (nose     - sh_mid) from -y
  mouth_angle_deg: number     // angle of (mouth_mid- sh_mid) from -y
  shoulder_slope_deg: number  // angle of L_sh - R_sh from the xz-horizontal

  // Visibilities (0..1) of the underlying landmarks. The classifier ignores
  // any head feature whose visibility falls below VIS_MIN.
  ear_vis: number
  nose_vis: number
  mouth_vis: number

  // Deviations from the calibrated upright baseline. Zero before calibration.
  ear_dev_deg: number
  nose_dev_deg: number
  mouth_dev_deg: number
  shoulder_slope_dev_deg: number

  // Calibration state, surfaced for the UI.
  calibrated: boolean
  calibration_progress: number  // 0..100, 100 once done
}

function emptyMetrics3D(): Metrics3D {
  return {
    ear_angle_deg: 0,
    nose_angle_deg: 0,
    mouth_angle_deg: 0,
    shoulder_slope_deg: 0,
    ear_vis: 0,
    nose_vis: 0,
    mouth_vis: 0,
    ear_dev_deg: 0,
    nose_dev_deg: 0,
    mouth_dev_deg: 0,
    shoulder_slope_dev_deg: 0,
    calibrated: false,
    calibration_progress: 0,
  }
}

// Per-frame snapshot of the landmarks the classifier reads. image_x/y are
// normalized [0,1] source-image coords for overlay positioning; image_z is
// MediaPipe's relative depth in the same scale. world_x/y/z are metric
// hip-origin coords. visibility is MediaPipe's [0,1] confidence that the
// landmark is in-frame and not occluded.
export type Landmark3D = {
  name: string
  image_x: number
  image_y: number
  image_z: number
  world_x: number
  world_y: number
  world_z: number
  visibility: number
}

// Raw per-frame angles before calibration is applied. Returned by
// computeRawAngles3D and consumed by both the calibration capture and the
// runtime classifier.
type RawAngles3D = {
  ear_angle_deg: number
  nose_angle_deg: number
  mouth_angle_deg: number
  shoulder_slope_deg: number
  ear_vis: number
  nose_vis: number
  mouth_vis: number
}

// Angle of (target - origin) from the -y axis (which is "up", since +y points
// down toward the floor in MediaPipe's image frame). Horizontal magnitude uses
// the xz-plane projection, sqrt(dx²+dz²), which is invariant under rotation
// about y. So the resulting angle is invariant under chair rotation: a user
// can spin in place without changing this number, AS LONG AS the input
// coordinate frame is camera-aligned (which the IMAGE frame is, but the
// WORLD frame is not — the world frame is body-rooted and drifts as the
// model re-estimates the body's orientation).
function angleFromUp(
  tx: number, ty: number, tz: number,
  ox: number, oy: number, oz: number,
): number {
  const dx = tx - ox
  const dy = ty - oy
  const dz = tz - oz
  const up = -dy                                // +y is down → -dy points up
  const horiz = Math.sqrt(dx * dx + dz * dz)    // xz-plane magnitude
  return Math.atan2(horiz, up) * (180 / Math.PI)
}

function computeRawAngles3D(
  world: PoseLandmarkerResult['worldLandmarks'][number],
  image: PoseLandmarkerResult['landmarks'][number],
): RawAngles3D {
  // ALL MATH USES IMAGE COORDINATES, NOT WORLD COORDINATES.
  // Image landmarks are camera-aligned: +x left in image, +y down (toward
  // floor), +z toward camera. The frame is fixed to the camera and does not
  // rotate when the subject rotates, so rotation about image-y (chair spin)
  // genuinely preserves the y component and the xz magnitude — which is the
  // entire premise of the rotation-invariant angle math.
  // World landmarks are still snapshotted and displayed in the overlay, but
  // the classifier ignores them. The `world` parameter is unused here on
  // purpose; kept so the call site stays the same.
  void world
  // Indices: 0 nose, 7 left ear, 8 right ear, 9 mouth left, 10 mouth right,
  // 11 left shoulder, 12 right shoulder.
  const nose = image[0]
  const lEar = image[7]
  const rEar = image[8]
  const lMo = image[9]
  const rMo = image[10]
  const lSh = image[11]
  const rSh = image[12]

  // Midpoints.
  const earX = (lEar.x + rEar.x) * 0.5
  const earY = (lEar.y + rEar.y) * 0.5
  const earZ = ((lEar.z ?? 0) + (rEar.z ?? 0)) * 0.5
  const moX = (lMo.x + rMo.x) * 0.5
  const moY = (lMo.y + rMo.y) * 0.5
  const moZ = ((lMo.z ?? 0) + (rMo.z ?? 0)) * 0.5
  const shX = (lSh.x + rSh.x) * 0.5
  const shY = (lSh.y + rSh.y) * 0.5
  const shZ = ((lSh.z ?? 0) + (rSh.z ?? 0)) * 0.5

  // Three rotation-invariant angles, one per head feature.
  const ear_angle_deg = angleFromUp(earX, earY, earZ, shX, shY, shZ)
  const nose_angle_deg = angleFromUp(nose.x, nose.y, nose.z ?? 0, shX, shY, shZ)
  const mouth_angle_deg = angleFromUp(moX, moY, moZ, shX, shY, shZ)

  // Shoulder line slope from horizontal. Same y-rotation invariance:
  // horizontal extent is xz-plane magnitude. Sign is preserved.
  const shDx = lSh.x - rSh.x
  const shDy = lSh.y - rSh.y
  const shDz = (lSh.z ?? 0) - (rSh.z ?? 0)
  const shHoriz = Math.sqrt(shDx * shDx + shDz * shDz)
  const shoulder_slope_deg = Math.atan2(shDy, shHoriz) * (180 / Math.PI)

  // Visibility for the head features. Mouth and ear use the worse of the L/R
  // pair so a half-occluded face downgrades the feature.
  const ear_vis = Math.min(image[7].visibility ?? 0, image[8].visibility ?? 0)
  const nose_vis = image[0].visibility ?? 0
  const mouth_vis = Math.min(image[9].visibility ?? 0, image[10].visibility ?? 0)

  return {
    ear_angle_deg,
    nose_angle_deg,
    mouth_angle_deg,
    shoulder_slope_deg,
    ear_vis,
    nose_vis,
    mouth_vis,
  }
}

type Classification3D = {
  status: PostureStatus
  score: number
}

function classify3D(m: Metrics3D): Classification3D {
  // Until calibrated, the deviations are meaningless — hold at good/100.
  if (!m.calibrated) {
    return { status: 'good', score: 100 }
  }

  // Head deviation = max of the per-feature deviations among VISIBLE features.
  // Each feature votes only if its visibility clears VIS_MIN — that way the
  // user can turn a quarter-profile and still get a usable signal from the
  // ear midpoint while nose drops out.
  let headDev = 0
  if (m.ear_vis >= VIS_MIN) {
    const v = m.ear_dev_deg
    if (v > headDev) headDev = v
  }
  if (m.nose_vis >= VIS_MIN) {
    const v = m.nose_dev_deg
    if (v > headDev) headDev = v
  }
  if (m.mouth_vis >= VIS_MIN) {
    const v = m.mouth_dev_deg
    if (v > headDev) headDev = v
  }

  const shDev = Math.abs(m.shoulder_slope_dev_deg)

  const headSev = headDev <= HEAD_DEV_WARN_DEG
    ? 0
    : (headDev - HEAD_DEV_WARN_DEG) / (HEAD_DEV_BAD_DEG - HEAD_DEV_WARN_DEG)
  const shSev = shDev <= SHOULDER_DEV_WARN_DEG
    ? 0
    : (shDev - SHOULDER_DEV_WARN_DEG) / (SHOULDER_DEV_BAD_DEG - SHOULDER_DEV_WARN_DEG)

  const worst = headSev > shSev ? headSev : shSev
  const capped = worst < 0 ? 0 : worst > 1 ? 1 : worst
  const score = Math.round((1 - capped) * 100)

  let status: PostureStatus = 'good'
  if (worst >= 1) status = 'bad'
  else if (worst > 0) status = 'warning'

  return { status, score }
}

function buildExplanation3D(m: Metrics3D, status: PostureStatus): ScoreExplanation {
  // While calibration is in progress or pending, the explanation is dedicated
  // to that flow — the user needs to know to sit upright and wait.
  if (!m.calibrated) {
    const pct = Math.round(m.calibration_progress)
    return {
      title: m.calibration_progress > 0
        ? `Calibrating upright posture (${pct}%)`
        : 'Sit upright and click Recalibrate to begin',
      summary: 'Recording your upright baseline so the rotation-invariant angles below have something to compare against.',
      primaryReason: 'Each head feature contributes one angle from vertical; chair rotation does not change those angles, only slouching does.',
      recommendation: 'Sit upright facing forward. Hold for ~1.5 s.',
      factors: [
        { label: 'Calibration', value: pct + '%', impact: 'neutral', description: 'Capturing upright baseline.' },
      ],
      insights: [
        'Calibration captures: ear-angle, nose-angle, mouth-angle, shoulder-slope.',
        'After calibration, deviations >|warn| trigger warning, >|bad| trigger bad.',
      ],
    }
  }

  const earDev = m.ear_dev_deg
  const noseDev = m.nose_dev_deg
  const mouthDev = m.mouth_dev_deg
  const shDev = Math.abs(m.shoulder_slope_dev_deg)

  const headImpact = (dev: number, vis: number): ScoreExplanationFactor['impact'] => {
    if (vis < VIS_MIN) return 'neutral'
    if (dev > HEAD_DEV_BAD_DEG) return 'negative'
    if (dev > HEAD_DEV_WARN_DEG) return 'neutral'
    return 'positive'
  }
  const shImpact: ScoreExplanationFactor['impact'] =
    shDev > SHOULDER_DEV_BAD_DEG ? 'negative' : shDev > SHOULDER_DEV_WARN_DEG ? 'neutral' : 'positive'

  const title = status === 'good'
    ? 'Posture steady'
    : status === 'warning'
      ? 'Posture drifting'
      : 'Posture bad'

  const summary =
    'Comparing each head feature angle against its calibrated upright baseline. Rotation-invariant under chair spinning; only changes in posture move these numbers.'

  const primaryReason =
    `Per-feature deviations from upright. Head warn ${HEAD_DEV_WARN_DEG}°, bad ${HEAD_DEV_BAD_DEG}°. Shoulder warn ${SHOULDER_DEV_WARN_DEG}°, bad ${SHOULDER_DEV_BAD_DEG}°.`

  const recommendation = status === 'good'
    ? 'Hold this alignment.'
    : 'Stack your head over your shoulders and level your shoulder line.'

  const fmt = (val: number, dev: number) =>
    `${val.toFixed(1)}° (Δ${dev >= 0 ? '+' : ''}${dev.toFixed(1)}°)`

  return {
    title,
    summary,
    primaryReason,
    recommendation,
    factors: [
      {
        label: 'Ear angle',
        value: fmt(m.ear_angle_deg, m.ear_dev_deg),
        impact: headImpact(earDev, m.ear_vis),
        description: `Angle of (ear_mid − sh_mid) from vertical. vis=${m.ear_vis.toFixed(2)}.`,
      },
      {
        label: 'Nose angle',
        value: fmt(m.nose_angle_deg, m.nose_dev_deg),
        impact: headImpact(noseDev, m.nose_vis),
        description: `Angle of (nose − sh_mid) from vertical. vis=${m.nose_vis.toFixed(2)}.`,
      },
      {
        label: 'Mouth angle',
        value: fmt(m.mouth_angle_deg, m.mouth_dev_deg),
        impact: headImpact(mouthDev, m.mouth_vis),
        description: `Angle of (mouth_mid − sh_mid) from vertical. vis=${m.mouth_vis.toFixed(2)}.`,
      },
      {
        label: 'Shoulder slope',
        value: fmt(m.shoulder_slope_deg, m.shoulder_slope_dev_deg),
        impact: shImpact,
        description: 'Shoulder line slope from horizontal, calibration-relative.',
      },
    ],
    insights: [
      `Head deviation: warn ${HEAD_DEV_WARN_DEG}°, bad ${HEAD_DEV_BAD_DEG}°. Shoulder: warn ${SHOULDER_DEV_WARN_DEG}°, bad ${SHOULDER_DEV_BAD_DEG}°.`,
      'Per-frame values logged to console as "[3D]". Click Recalibrate to re-record baseline.',
    ],
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
  const [metrics3D, setMetrics3D] = useState<Metrics3D>(emptyMetrics3D)
  const [landmarks3D, setLandmarks3D] = useState<Landmark3D[]>([])

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
  // EMA for the 2D-mode forwardHead value. forwardHead is the rotation-
  // invariant 3D ear angle (in degrees) and has a per-frame noise floor of
  // ~1-3°. Because severity is asymmetric (only positive deviations from the
  // upright baseline count), feeding raw values into the classifier biases
  // the score downward at perfect posture. Smoothing both the runtime value
  // AND the calibration samples keeps them in the same regime, so deviation
  // converges to ~0 at upright. Matches ANGLE_EMA_ALPHA used by 3D mode.
  const smoothedForwardHeadRef = useRef<number | null>(null)
  const explanationRef = useRef<ExplanationSnapshot>({ status: 'good', issue: null })
  const lastExplanationUpdateRef = useRef(0)
  const lastAlertTimeRef = useRef(0)
  const lastBannerTimeRef = useRef(0)
  const lastReportedStatusRef = useRef<PostureStatus>('good')
  const statusHistoryRef = useRef<PostureStatus[]>([])
  const smoothedScoreRef = useRef(100)
  // EMA of the raw per-frame angles, applied before classification.
  const smoothedAnglesRef = useRef<RawAngles3D>({
    ear_angle_deg: 0, nose_angle_deg: 0, mouth_angle_deg: 0,
    shoulder_slope_deg: 0, ear_vis: 0, nose_vis: 0, mouth_vis: 0,
  })
  // Whether smoothedAnglesRef has been seeded by the first frame yet.
  const smoothedAnglesSeededRef = useRef(false)
  // Calibration baseline. null until the user has held an upright pose for
  // the capture window. Replaced wholesale on each Recalibrate.
  const calib3DRef = useRef<{
    ear_angle_deg: number
    nose_angle_deg: number
    mouth_angle_deg: number
    shoulder_slope_deg: number
  } | null>(null)
  const calib3DSamplesRef = useRef<RawAngles3D[]>([])
  const calib3DStartRef = useRef(0)
  // 'idle'      = no capture in progress, waiting for the user to click
  //               "Capture Good Posture" in the modal.
  // 'capturing' = sampling for CAPTURE_3D_MS.
  // 'done'      = baseline stored in calib3DRef, deviations active.
  const calib3DStateRef = useRef<'idle' | 'capturing' | 'done'>('idle')

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

    // 3D mode reuses the 2D CalibrationPanel modal: calibrationStep starts at
    // 'good' (the React useState default), so the modal renders. The user
    // clicks "Capture Good Posture", which routes to the 3D capture below.
    // baselineRef is set to a non-null sentinel so the 2D-path guards that
    // gate on it don't reject 3D frames.
    if (USE_3D_MODE) {
      baselineRef.current = 1
    }

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
    smoothedForwardHeadRef.current = null
    explanationRef.current = { status: 'good', issue: null }
    lastExplanationUpdateRef.current = 0
    statusHistoryRef.current = []
    smoothedScoreRef.current = 100
    // Reset the 3D calibration too — Recalibrate is the user's signal that
    // they're sitting upright and want a new baseline captured.
    calib3DRef.current = null
    calib3DSamplesRef.current = []
    calib3DStateRef.current = 'idle'
    smoothedAnglesSeededRef.current = false
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
    if (USE_3D_MODE) {
      // Arm the 3D capture. The 3D branch in processResult sees state ===
      // 'capturing' on the next frame, pushes samples for CAPTURE_3D_MS, then
      // averages and dismisses the modal.
      calib3DRef.current = null
      calib3DSamplesRef.current = []
      calib3DStartRef.current = performance.now()
      calib3DStateRef.current = 'capturing'
      smoothedAnglesSeededRef.current = false
      setCalibrationProgress(0)
      setIsCapturingCalibration(true)
      return
    }
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

    // ---- 3D MODE PATH. Bypasses calibration and the 2D feature pipeline. ----
    if (USE_3D_MODE) {
      const world = result.worldLandmarks && result.worldLandmarks[0]
      if (!world) return
      const img = result.landmarks[0]

      // ---- Step 1: per-frame raw angles. ----
      const raw = computeRawAngles3D(world, img)

      // ---- Step 2: EMA the raw angles. Seeded on first frame. ----
      if (!smoothedAnglesSeededRef.current) {
        smoothedAnglesRef.current = { ...raw }
        smoothedAnglesSeededRef.current = true
      } else {
        const sm = smoothedAnglesRef.current
        const a = ANGLE_EMA_ALPHA
        sm.ear_angle_deg = sm.ear_angle_deg * (1 - a) + raw.ear_angle_deg * a
        sm.nose_angle_deg = sm.nose_angle_deg * (1 - a) + raw.nose_angle_deg * a
        sm.mouth_angle_deg = sm.mouth_angle_deg * (1 - a) + raw.mouth_angle_deg * a
        sm.shoulder_slope_deg =
          sm.shoulder_slope_deg * (1 - a) + raw.shoulder_slope_deg * a
        sm.ear_vis = raw.ear_vis
        sm.nose_vis = raw.nose_vis
        sm.mouth_vis = raw.mouth_vis
      }
      const sm = smoothedAnglesRef.current

      // ---- Step 3: calibration capture state machine. ----
      // idle      → no-op. Waiting for the user to click "Capture Good Posture"
      //             in the modal, which arms calib3DStateRef = 'capturing' and
      //             starts the timer.
      // capturing → push the smoothed sample, finalize when window elapsed
      //             AND min sample count reached, then dismiss the modal.
      // done      → no-op here. Deviations get computed below.
      let calibProgress = 100
      if (calib3DStateRef.current === 'capturing') {
        calib3DSamplesRef.current.push({ ...sm })
        const elapsed = performance.now() - calib3DStartRef.current
        calibProgress = Math.min(99, Math.round((elapsed / CAPTURE_3D_MS) * 100))
        setCalibrationProgress(calibProgress)
        if (elapsed >= CAPTURE_3D_MS &&
            calib3DSamplesRef.current.length >= CAPTURE_3D_MIN_SAMPLES) {
          const samples = calib3DSamplesRef.current
          const n = samples.length
          let ear = 0, nose = 0, mouth = 0, sh = 0
          for (const s of samples) {
            ear += s.ear_angle_deg
            nose += s.nose_angle_deg
            mouth += s.mouth_angle_deg
            sh += s.shoulder_slope_deg
          }
          calib3DRef.current = {
            ear_angle_deg: ear / n,
            nose_angle_deg: nose / n,
            mouth_angle_deg: mouth / n,
            shoulder_slope_deg: sh / n,
          }
          calib3DStateRef.current = 'done'
          calibProgress = 100
          setIsCapturingCalibration(false)
          setCalibrationProgress(100)
          setCalibrationStep('done')
        }
      }

      // ---- Step 4: deviations (zero until calibrated). ----
      const cal = calib3DRef.current
      const calibrated = cal !== null
      const ear_dev_deg = cal ? sm.ear_angle_deg - cal.ear_angle_deg : 0
      const nose_dev_deg = cal ? sm.nose_angle_deg - cal.nose_angle_deg : 0
      const mouth_dev_deg = cal ? sm.mouth_angle_deg - cal.mouth_angle_deg : 0
      const shoulder_slope_dev_deg = cal
        ? sm.shoulder_slope_deg - cal.shoulder_slope_deg
        : 0

      const m: Metrics3D = {
        ear_angle_deg: sm.ear_angle_deg,
        nose_angle_deg: sm.nose_angle_deg,
        mouth_angle_deg: sm.mouth_angle_deg,
        shoulder_slope_deg: sm.shoulder_slope_deg,
        ear_vis: sm.ear_vis,
        nose_vis: sm.nose_vis,
        mouth_vis: sm.mouth_vis,
        ear_dev_deg,
        nose_dev_deg,
        mouth_dev_deg,
        shoulder_slope_dev_deg,
        calibrated,
        calibration_progress: calibProgress,
      }

      // ---- Step 5: classify. ----
      const decision = classify3D(m)
      smoothedScoreRef.current =
        smoothedScoreRef.current * (1 - SCORE_EMA_ALPHA_3D) + decision.score * SCORE_EMA_ALPHA_3D
      const finalScore = Math.round(smoothedScoreRef.current)

      // ---- Step 6: snapshot landmarks for the overlay (7 points). ----
      setLandmarks3D([
        {
          name: 'L Ear',
          image_x: img[7].x, image_y: img[7].y, image_z: img[7].z ?? 0,
          world_x: world[7].x, world_y: world[7].y, world_z: world[7].z,
          visibility: img[7].visibility ?? 0,
        },
        {
          name: 'R Ear',
          image_x: img[8].x, image_y: img[8].y, image_z: img[8].z ?? 0,
          world_x: world[8].x, world_y: world[8].y, world_z: world[8].z,
          visibility: img[8].visibility ?? 0,
        },
        {
          name: 'L Shoulder',
          image_x: img[11].x, image_y: img[11].y, image_z: img[11].z ?? 0,
          world_x: world[11].x, world_y: world[11].y, world_z: world[11].z,
          visibility: img[11].visibility ?? 0,
        },
        {
          name: 'R Shoulder',
          image_x: img[12].x, image_y: img[12].y, image_z: img[12].z ?? 0,
          world_x: world[12].x, world_y: world[12].y, world_z: world[12].z,
          visibility: img[12].visibility ?? 0,
        },
        {
          name: 'Nose',
          image_x: img[0].x, image_y: img[0].y, image_z: img[0].z ?? 0,
          world_x: world[0].x, world_y: world[0].y, world_z: world[0].z,
          visibility: img[0].visibility ?? 0,
        },
        {
          name: 'L Mouth',
          image_x: img[9].x, image_y: img[9].y, image_z: img[9].z ?? 0,
          world_x: world[9].x, world_y: world[9].y, world_z: world[9].z,
          visibility: img[9].visibility ?? 0,
        },
        {
          name: 'R Mouth',
          image_x: img[10].x, image_y: img[10].y, image_z: img[10].z ?? 0,
          world_x: world[10].x, world_y: world[10].y, world_z: world[10].z,
          visibility: img[10].visibility ?? 0,
        },
      ])

      // ---- Step 7: log. Unthrottled, fixed columns. ----
      const calStr = calibrated ? 'CAL' : `cal${calibProgress}%`
      console.log(
        `[3D] ${calStr} ` +
          `ear=${sm.ear_angle_deg.toFixed(1).padStart(6)}°(Δ${ear_dev_deg.toFixed(1).padStart(5)}) ` +
          `nose=${sm.nose_angle_deg.toFixed(1).padStart(6)}°(Δ${nose_dev_deg.toFixed(1).padStart(5)}) ` +
          `mouth=${sm.mouth_angle_deg.toFixed(1).padStart(6)}°(Δ${mouth_dev_deg.toFixed(1).padStart(5)}) ` +
          `shS=${sm.shoulder_slope_deg.toFixed(1).padStart(6)}°(Δ${shoulder_slope_dev_deg.toFixed(1).padStart(5)}) ` +
          `vis e=${sm.ear_vis.toFixed(2)} n=${sm.nose_vis.toFixed(2)} m=${sm.mouth_vis.toFixed(2)} ` +
          `→ ${decision.status} score=${finalScore}`,
      )

      // ---- Step 8: push to React state. ----
      setMetrics3D(m)
      setScore(finalScore)
      setConfidence(95)
      if (decision.status !== status) setStatus(decision.status)
      setExplanation(buildExplanation3D(m, decision.status))

      if (decision.status !== lastReportedStatusRef.current) {
        if (decision.status === 'good') {
          window.electronAPI?.hideOverlay()
        } else if (alertMode === 'overlay' || alertMode === 'both') {
          window.electronAPI?.showOverlay(decision.status)
        }
        lastReportedStatusRef.current = decision.status
      }

      if (decision.status !== 'good') {
        const nowMs = Date.now()
        if (nowMs - lastAlertTimeRef.current > 15000) {
          const alert: PostureAlert = {
            id: nowMs.toString(),
            timestamp: new Date(),
            type: decision.status,
            message: randomMsg(decision.status),
          }
          setAlerts((prevAlerts) => [alert, ...prevAlerts].slice(0, 50))
          lastAlertTimeRef.current = nowMs
        }

        if (window.electronAPI && (alertMode === 'banner' || alertMode === 'both')) {
          const nowBanner = Date.now()
          const cooldownMs = getNotificationIntervalMs(notificationFrequency)
          if (cooldownMs === 0 || nowBanner - lastBannerTimeRef.current >= cooldownMs) {
            const body =
              decision.status === 'bad'
                ? 'Head deviation from upright baseline exceeded the bad threshold.'
                : 'Posture drifting from upright baseline.'
            window.electronAPI.sendNotification('SitRight — Posture Alert', body)
            lastBannerTimeRef.current = nowBanner
          }
        }
      }

      return
    }
    // ---- End 3D path. Below is the original 2D pipeline, unchanged. ----

    // EMA the forwardHead angle in place. Both the calibration capture below
    // and the severity computation in buildIssueAnalyses see the smoothed
    // value, so the calibrated baseline and the runtime measurement live in
    // the same noise regime. Without this, per-frame angle jitter (~1-3°)
    // crosses the WARN threshold on roughly half the frames at perfect
    // upright posture and drags the score down to the 85-95 range.
    {
      const prev = smoothedForwardHeadRef.current
      const next = prev === null
        ? pose.features.forwardHead
        : prev * (1 - ANGLE_EMA_ALPHA) + pose.features.forwardHead * ANGLE_EMA_ALPHA
      smoothedForwardHeadRef.current = next
      pose.features.forwardHead = next
    }

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

    // Yaw gate. When the user is facing the camera, all six features vote via
    // the existing weighted sum + 25% legacy blend. When the user is rotated
    // past YAW_HIGH_DEG, the 2D pixel features (headLift, torsoLean, the two
    // tilts, shoulderRelaxation) become unreliable. The score collapses to
    // forwardHead severity alone — which is the rotation-invariant 3D
    // ear-angle metric — and the legacy ratio (also pixel-based) is dropped.
    const yawHigh = pose.bodyRotationDeg >= YAW_HIGH_DEG
    let featureScore: number
    if (yawHigh) {
      const fwd = issues.find((i) => i.key === 'forwardHead')
      const fwdSev = fwd ? fwd.severity : 0
      featureScore = clampPercent((1 - clamp(fwdSev, 0, 1)) * 100)
    } else {
      const weightedPenalty = issues.reduce((sum, issue) => sum + issue.severity * FEATURE_WEIGHTS[issue.key], 0)
      featureScore = clampPercent((1 - clamp(weightedPenalty, 0, 1)) * 100)
    }
    const legacyScore = clampPercent(((ratio - profile.badThreshold) / (1 - profile.badThreshold)) * 100)
    const rawScore = yawHigh
      ? featureScore
      : clampPercent(featureScore * 0.75 + legacyScore * 0.25)

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
    metrics3D,
    landmarks3D,
    toggleMonitoring: () => setIsMonitoring((prev) => !prev),
    setVideo: (video: HTMLVideoElement | null) => {
      videoRef.current = video
    },
    recalibrate: resetCalibration,
    captureGoodPosture,
    captureBadPosture,
  }
}