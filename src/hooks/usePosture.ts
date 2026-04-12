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
const USE_3D_MODE = true

// Absolute sagittal-angle thresholds (degrees from vertical). Tune by watching
// the debug metrics; these are starting points for a seated desk user.
const NECK_WARN_DEG = 15
const NECK_BAD_DEG = 28
const SHOULDER_SLOPE_WARN_DEG = 6
const SHOULDER_SLOPE_BAD_DEG = 12

// Light EMA on the neck angle (the one signal the classifier cares about).
const ANGLE_EMA_ALPHA = 0.25
const SCORE_EMA_ALPHA_3D = 0.30

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

export type Metrics3D = {
  // All metrics below are rotation-invariant in the horizontal (XZ) plane.
  // They do not assume the subject is facing the camera. Derived purely from
  // ear (7, 8) and shoulder (11, 12) world landmarks in meters. No hip reads.
  neck_deviation_deg: number  // angle between shoulder→ear vector and vertical
  neck_offset_cm: number      // horizontal distance ear-mid is off shoulder-mid
  shoulder_slope_deg: number  // angle of shoulder line from horizontal (3D)
  head_slope_deg: number      // angle of ear line from horizontal (3D)
  body_rotation_deg: number   // 0 = facing camera, 90 = profile. Diagnostic.
}

function emptyMetrics3D(): Metrics3D {
  return {
    neck_deviation_deg: 0,
    neck_offset_cm: 0,
    shoulder_slope_deg: 0,
    head_slope_deg: 0,
    body_rotation_deg: 0,
  }
}

// Per-frame snapshot of a landmark for the overlay. image_x/y are normalized
// source-image coordinates in [0, 1] — position the dot with these. world_x/y/z
// are metric hip-origin coords — display these as labels. visibility is
// MediaPipe's model-predicted [0, 1] score indicating how confident it is that
// this landmark is both in the frame AND not occluded.
export type Landmark3D = {
  name: 'L Ear' | 'R Ear' | 'L Shoulder' | 'R Shoulder'
  image_x: number
  image_y: number
  world_x: number
  world_y: number
  world_z: number
  visibility: number
}

function computeMetrics3D(world: PoseLandmarkerResult['worldLandmarks'][number]): Metrics3D {
  // MediaPipe worldLandmarks frame: origin at hip midpoint, axes locked to the
  // camera (NOT the body). +x image-right, +y image-down, +z away from camera.
  // The axes do not rotate when the subject rotates, so any "frontal plane"
  // or "sagittal plane" interpretation has to be recovered from 3D vectors —
  // which is what everything below does.
  const lEar = world[7]
  const rEar = world[8]
  const lSh = world[11]
  const rSh = world[12]

  // Midpoints.
  const earX = (lEar.x + rEar.x) * 0.5
  const earY = (lEar.y + rEar.y) * 0.5
  const earZ = (lEar.z + rEar.z) * 0.5
  const shX = (lSh.x + rSh.x) * 0.5
  const shY = (lSh.y + rSh.y) * 0.5
  const shZ = (lSh.z + rSh.z) * 0.5

  // ---- Neck deviation from vertical. ----
  // Shoulder→ear vector. Up component is -dy (since +y is image-down).
  // Horizontal component is the XZ-plane magnitude — direction-agnostic,
  // which makes the metric rotation-invariant.
  const neckDx = earX - shX
  const neckDy = earY - shY
  const neckDz = earZ - shZ
  const neckUp = -neckDy
  const neckHoriz = Math.sqrt(neckDx * neckDx + neckDz * neckDz)
  const neck_deviation_deg = Math.atan2(neckHoriz, neckUp) * (180 / Math.PI)
  const neck_offset_cm = neckHoriz * 100

  // ---- Shoulder slope from horizontal (3D). ----
  // Full 3D horizontal extent (sqrt(dx² + dz²)) means a level shoulder line
  // reads ~0° whether shoulders are separated in image-X (facing camera) or
  // image-Z (profile). Sign of dy preserved: + = subject's left lower.
  const shDx = lSh.x - rSh.x
  const shDy = lSh.y - rSh.y
  const shDz = lSh.z - rSh.z
  const shHoriz = Math.sqrt(shDx * shDx + shDz * shDz)
  const shoulder_slope_deg = Math.atan2(shDy, shHoriz) * (180 / Math.PI)

  // ---- Head slope from horizontal (3D). ----
  const earDx = lEar.x - rEar.x
  const earDy = lEar.y - rEar.y
  const earDz = lEar.z - rEar.z
  const earHoriz = Math.sqrt(earDx * earDx + earDz * earDz)
  const head_slope_deg = Math.atan2(earDy, earHoriz) * (180 / Math.PI)

  // ---- Body rotation from facing-camera. ----
  // How much the shoulder line is rotated out of the image plane. 0 means
  // facing camera, 90 means profile view. Diagnostic, not a classifier input.
  const body_rotation_deg =
    Math.atan2(Math.abs(shDz), Math.abs(shDx)) * (180 / Math.PI)

  return {
    neck_deviation_deg,
    neck_offset_cm,
    shoulder_slope_deg,
    head_slope_deg,
    body_rotation_deg,
  }
}

type Classification3D = {
  status: PostureStatus
  score: number
}

function classify3D(m: Metrics3D): Classification3D {
  // Classifier inputs: neck deviation from vertical + shoulder slope from
  // horizontal. Both are rotation-invariant, so profile view doesn't inflate
  // them. body_rotation_deg is NOT used — it's diagnostic only.
  //
  // Score is 100 minus the worst axis's piecewise-linear severity. Severity
  // is 0 in the no-penalty band up to WARN, then ramps linearly to 1 at BAD.
  const neckAbs = Math.abs(m.neck_deviation_deg)
  const shSlopeAbs = Math.abs(m.shoulder_slope_deg)

  const neckSev = neckAbs <= NECK_WARN_DEG
    ? 0
    : (neckAbs - NECK_WARN_DEG) / (NECK_BAD_DEG - NECK_WARN_DEG)
  const shSev = shSlopeAbs <= SHOULDER_SLOPE_WARN_DEG
    ? 0
    : (shSlopeAbs - SHOULDER_SLOPE_WARN_DEG) / (SHOULDER_SLOPE_BAD_DEG - SHOULDER_SLOPE_WARN_DEG)

  const worst = neckSev > shSev ? neckSev : shSev
  const capped = worst < 0 ? 0 : worst > 1 ? 1 : worst
  const score = Math.round((1 - capped) * 100)

  let status: PostureStatus = 'good'
  if (worst >= 1) status = 'bad'
  else if (worst > 0) status = 'warning'

  return { status, score }
}

function buildExplanation3D(m: Metrics3D, status: PostureStatus): ScoreExplanation {
  // EVERYTHING below is frame-stable. Title, summary, primaryReason, and
  // recommendation are functions of status ONLY — they do not rotate based on
  // which axis is momentarily worst. Factor rows always appear in the same
  // order. Only the numeric text and the impact color change per frame.
  const neckAbs = Math.abs(m.neck_deviation_deg)
  const shAbs = Math.abs(m.shoulder_slope_deg)

  const neckImpact: ScoreExplanationFactor['impact'] =
    neckAbs > NECK_BAD_DEG ? 'negative' : neckAbs > NECK_WARN_DEG ? 'neutral' : 'positive'
  const shImpact: ScoreExplanationFactor['impact'] =
    shAbs > SHOULDER_SLOPE_BAD_DEG ? 'negative' : shAbs > SHOULDER_SLOPE_WARN_DEG ? 'neutral' : 'positive'

  const title = status === 'good'
    ? 'Posture steady'
    : status === 'warning'
      ? 'Posture drifting'
      : 'Posture bad'

  const summary =
    'Classifier reads neck deviation from vertical and shoulder slope from horizontal. Both are rotation-invariant in the horizontal plane, so turning your chair does not inflate them.'

  const primaryReason =
    `Absolute thresholds on MediaPipe world landmarks. Neck warn ${NECK_WARN_DEG}°, bad ${NECK_BAD_DEG}°. Shoulder slope warn ${SHOULDER_SLOPE_WARN_DEG}°, bad ${SHOULDER_SLOPE_BAD_DEG}°.`

  const recommendation = status === 'good'
    ? 'Hold this alignment.'
    : 'Stack your head over your shoulders and level your shoulder line.'

  return {
    title,
    summary,
    primaryReason,
    recommendation,
    factors: [
      {
        label: 'Neck deviation from vertical',
        value: m.neck_deviation_deg.toFixed(1) + '°',
        impact: neckImpact,
        description: 'Angle between the shoulder→ear vector and straight up. Rotation-invariant. Classifier input.',
      },
      {
        label: 'Neck horizontal offset',
        value: m.neck_offset_cm.toFixed(1) + ' cm',
        impact: 'neutral',
        description: 'Horizontal distance of the ear midpoint from directly above the shoulder midpoint.',
      },
      {
        label: 'Shoulder slope',
        value: m.shoulder_slope_deg.toFixed(1) + '°',
        impact: shImpact,
        description: 'Angle of the shoulder line from horizontal, in 3D. Classifier input.',
      },
      {
        label: 'Head slope',
        value: m.head_slope_deg.toFixed(1) + '°',
        impact: 'neutral',
        description: 'Angle of the ear line from horizontal, in 3D.',
      },
      {
        label: 'Body rotation',
        value: m.body_rotation_deg.toFixed(1) + '°',
        impact: 'neutral',
        description: '0 = facing camera, 90 = profile view. Diagnostic only; not used for scoring.',
      },
    ],
    insights: [
      `Neck warn ${NECK_WARN_DEG}°, bad ${NECK_BAD_DEG}°. Shoulder slope warn ${SHOULDER_SLOPE_WARN_DEG}°, bad ${SHOULDER_SLOPE_BAD_DEG}°.`,
      'Per-frame values are logged to the console. Filter devtools for "[3D]".',
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
  const explanationRef = useRef<ExplanationSnapshot>({ status: 'good', issue: null })
  const lastExplanationUpdateRef = useRef(0)
  const lastAlertTimeRef = useRef(0)
  const lastBannerTimeRef = useRef(0)
  const lastReportedStatusRef = useRef<PostureStatus>('good')
  const statusHistoryRef = useRef<PostureStatus[]>([])
  const smoothedScoreRef = useRef(100)
  const smoothedMetrics3DRef = useRef<Metrics3D>(emptyMetrics3D())

  useEffect(() => {
    async function initMediaPipe() {
      try {
        const vision = await FilesetResolver.forVisionTasks('/wasm')
        const poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            // modelAssetPath: '/models/pose_landmarker_lite.task',
            // modelAssetPath: '/models/pose_landmarker_full.task',
            modelAssetPath: '/models/pose_landmarker_heavy.task',
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

    // 3D mode has no calibration; mark it done immediately so any UI that
    // gates on calibrationStep goes straight to live monitoring.
    if (USE_3D_MODE) {
      setCalibrationStep('done')
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

    // ---- 3D MODE PATH. Bypasses calibration and the 2D feature pipeline. ----
    if (USE_3D_MODE) {
      const world = result.worldLandmarks && result.worldLandmarks[0]
      if (!world) return

      const raw = computeMetrics3D(world)

      // Snapshot the four landmarks the classifier actually uses, packaged with
      // image coords (for overlay positioning), world coords (for label text),
      // and visibility (for confidence indication).
      const img = result.landmarks[0]
      setLandmarks3D([
        {
          name: 'L Ear',
          image_x: img[7].x, image_y: img[7].y,
          world_x: world[7].x, world_y: world[7].y, world_z: world[7].z,
          visibility: img[7].visibility ?? 0,
        },
        {
          name: 'R Ear',
          image_x: img[8].x, image_y: img[8].y,
          world_x: world[8].x, world_y: world[8].y, world_z: world[8].z,
          visibility: img[8].visibility ?? 0,
        },
        {
          name: 'L Shoulder',
          image_x: img[11].x, image_y: img[11].y,
          world_x: world[11].x, world_y: world[11].y, world_z: world[11].z,
          visibility: img[11].visibility ?? 0,
        },
        {
          name: 'R Shoulder',
          image_x: img[12].x, image_y: img[12].y,
          world_x: world[12].x, world_y: world[12].y, world_z: world[12].z,
          visibility: img[12].visibility ?? 0,
        },
      ])

      // Light EMA on the neck deviation — the one score-driving signal. The
      // other metrics pass through unsmoothed so the log shows the real
      // per-frame noise floor.
      const prev = smoothedMetrics3DRef.current
      raw.neck_deviation_deg =
        prev.neck_deviation_deg * (1 - ANGLE_EMA_ALPHA) + raw.neck_deviation_deg * ANGLE_EMA_ALPHA
      smoothedMetrics3DRef.current = raw

      const decision = classify3D(raw)
      smoothedScoreRef.current =
        smoothedScoreRef.current * (1 - SCORE_EMA_ALPHA_3D) + decision.score * SCORE_EMA_ALPHA_3D
      const finalScore = Math.round(smoothedScoreRef.current)

      // Per-frame log of every metric plus the decision. Unthrottled.
      // Filter devtools for "[3D]" to isolate. Fixed column order so you
      // can grep and diff.
      console.log(
        `[3D] neckDev=${raw.neck_deviation_deg.toFixed(1).padStart(6)}° ` +
          `neckOff=${raw.neck_offset_cm.toFixed(1).padStart(6)}cm ` +
          `shSlope=${raw.shoulder_slope_deg.toFixed(1).padStart(6)}° ` +
          `hdSlope=${raw.head_slope_deg.toFixed(1).padStart(6)}° ` +
          `bodyRot=${raw.body_rotation_deg.toFixed(1).padStart(6)}° ` +
          `→ ${decision.status} score=${finalScore}`,
      )

      setMetrics3D(raw)
      setScore(finalScore)
      setConfidence(95)
      if (decision.status !== status) setStatus(decision.status)
      setExplanation(buildExplanation3D(raw, decision.status))

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
                ? 'Neck deviation or shoulder slope exceeded the bad threshold. Reset your posture.'
                : 'Posture drifting in 3D mode. Small adjustment recommended.'
            window.electronAPI.sendNotification('SitRight — Posture Alert', body)
            lastBannerTimeRef.current = nowBanner
          }
        }
      }

      return
    }
    // ---- End 3D path. Below is the original 2D pipeline, unchanged. ----

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