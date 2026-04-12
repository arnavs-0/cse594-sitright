import type { Landmark3D } from '../hooks/usePosture'

interface LandmarkOverlayProps {
  landmarks: Landmark3D[]
  // Source video intrinsic dimensions. Used as the SVG viewBox so that
  // preserveAspectRatio="xMidYMid slice" reproduces the same crop that CSS
  // object-cover applies to the <video> element — landmarks then land on the
  // correct pixels regardless of display size.
  videoWidth: number
  videoHeight: number
  // The video is rendered mirrored (scaleX(-1)) in CameraFeed. We mirror the
  // dot positions manually here so that text labels stay readable rather than
  // applying a CSS transform that would flip the text too.
  mirrored?: boolean
}

const VISIBILITY_THRESHOLD = 0.5

export default function LandmarkOverlay({
  landmarks,
  videoWidth,
  videoHeight,
  mirrored = true,
}: LandmarkOverlayProps) {
  if (!videoWidth || !videoHeight || landmarks.length === 0) return null

  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none"
      viewBox={`0 0 ${videoWidth} ${videoHeight}`}
      preserveAspectRatio="xMidYMid slice"
    >
      {landmarks.map((lm) => {
        const rawX = lm.image_x * videoWidth
        const cx = mirrored ? videoWidth - rawX : rawX
        const cy = lm.image_y * videoHeight

        // Dot color encodes visibility. Red = high-confidence visible; dimmer
        // red with a ring = model thinks it's occluded or off-frame.
        const isVisible = lm.visibility >= VISIBILITY_THRESHOLD
        const fill = isVisible ? '#ef4444' : '#7f1d1d'
        const ringOpacity = isVisible ? 0 : 1

        return (
          <g key={lm.name}>
            <circle
              cx={cx}
              cy={cy}
              r={7}
              fill={fill}
              stroke="white"
              strokeWidth={1.5}
            />
            <circle
              cx={cx}
              cy={cy}
              r={12}
              fill="none"
              stroke="#ef4444"
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={ringOpacity}
            />
            <text
              x={cx + 14}
              y={cy - 4}
              fontSize={12}
              fontFamily="monospace"
              fill="white"
              stroke="black"
              strokeWidth={3}
              paintOrder="stroke"
              style={{ fontWeight: 600 }}
            >
              {lm.name}  v={lm.visibility.toFixed(2)}
            </text>
            <text
              x={cx + 14}
              y={cy + 12}
              fontSize={11}
              fontFamily="monospace"
              fill="white"
              stroke="black"
              strokeWidth={3}
              paintOrder="stroke"
            >
              x={lm.world_x.toFixed(2)} y={lm.world_y.toFixed(2)} z={lm.world_z.toFixed(2)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
