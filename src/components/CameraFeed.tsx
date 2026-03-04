import { useEffect, useRef, useState } from 'react'
import { PostureStatus } from '../types'

interface CameraFeedProps {
  onVideoRef: (video: HTMLVideoElement | null) => void
  isMonitoring: boolean
  status: PostureStatus
  score: number
  selectedDeviceId?: string
  onDeviceChange?: (deviceId: string) => void
  onRecalibrate: () => void
}

const FEEDBACK_MESSAGES: Record<PostureStatus, string> = {
  good: 'Posture looks great! Keep it up.',
  warning: 'Leaning forward? Try to sit back.',
  bad: 'Slouching detected! Sit up straight.',
}

export default function CameraFeed({ 
  onVideoRef, 
  isMonitoring, 
  status, 
  score, 
  selectedDeviceId,
  onDeviceChange,
  onRecalibrate
}: CameraFeedProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [showDevicePicker, setShowDevicePicker] = useState(false)

  useEffect(() => {
    async function getDevices() {
      try {
        const allDevices = await navigator.mediaDevices.enumerateDevices()
        const videoDevices = allDevices.filter(device => device.kind === 'videoinput')
        setDevices(videoDevices)
        
        if (!selectedDeviceId && videoDevices.length > 0 && onDeviceChange) {
          onDeviceChange(videoDevices[0].deviceId)
        }
      } catch (err) {
        console.error('Error enumerating devices:', err)
      }
    }
    getDevices()
    
    navigator.mediaDevices.ondevicechange = getDevices
    return () => {
      navigator.mediaDevices.ondevicechange = null
    }
  }, [selectedDeviceId, onDeviceChange])

  useEffect(() => {
    let currentStream: MediaStream | null = null

    async function setupCamera() {
      try {
        if (stream) {
          stream.getTracks().forEach(track => track.stop())
          setStream(null)
        }

        if (!isMonitoring) return

        const constraints = {
          video: {
            deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
            width: { ideal: 640 },
            height: { ideal: 480 },
            facingMode: selectedDeviceId ? undefined : 'user'
          }
        }

        const newStream = await navigator.mediaDevices.getUserMedia(constraints)
        currentStream = newStream
        if (videoRef.current) {
          videoRef.current.srcObject = newStream
          setStream(newStream)
          onVideoRef(videoRef.current)
        }
        setError(null)
      } catch (err) {
        console.error('Error accessing camera:', err)
        setError('Camera access denied or device busy.')
      }
    }

    setupCamera()

    return () => {
      if (currentStream) {
        currentStream.getTracks().forEach(track => track.stop())
      }
    }
  }, [isMonitoring, selectedDeviceId])

  const statusColor = {
    good: 'border-emerald-500/60',
    warning: 'border-amber-500/60',
    bad: 'border-red-500/60',
  }[status]

  return (
    <div className={`relative aspect-video bg-slate-900 rounded-2xl overflow-hidden border-2 shadow-xl transition-all duration-500 ${isMonitoring ? statusColor : 'border-slate-700/50'}`}>
      {error ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center p-4 text-center">
          <span className="text-red-400 font-medium mb-1">Camera Error</span>
          <span className="text-xs text-slate-500">{error}</span>
          <button 
            onClick={() => setShowDevicePicker(!showDevicePicker)}
            className="mt-4 px-3 py-1 bg-slate-800 rounded-lg text-[10px] text-white/70 hover:bg-slate-700 transition-colors"
          >
            Switch Camera
          </button>
        </div>
      ) : (
        <>
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`w-full h-full object-cover transition-opacity duration-500 ${isMonitoring ? 'opacity-100' : 'opacity-20'}`}
            style={{ transform: 'scaleX(-1)' }}
          />
          
          {/* Visual Feedback Overlay */}
          {isMonitoring && (
            <div className="absolute inset-0 pointer-events-none flex flex-col justify-between p-4">
              <div className="flex justify-between items-start">
                <div className="flex items-center gap-2">
                  <div className={`w-2 h-2 rounded-full ${status === 'good' ? 'bg-emerald-500' : status === 'warning' ? 'bg-amber-500' : 'bg-red-500'} animate-pulse`} />
                  <span className="text-[10px] uppercase tracking-widest font-bold text-white/90 bg-black/40 backdrop-blur-md px-2 py-1 rounded border border-white/10">
                    AI Active
                  </span>
                </div>
                <div className="flex flex-col gap-2 pointer-events-auto">
                   <button 
                    onClick={() => setShowDevicePicker(!showDevicePicker)}
                    className="bg-black/40 backdrop-blur-md px-2 py-1 rounded border border-white/10 text-white/70 font-mono text-[10px] flex items-center gap-1 hover:text-white transition-colors"
                   >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                    Source
                   </button>
                   <button 
                    onClick={() => {
                      onRecalibrate()
                      // Brief visual feedback
                      const btn = document.activeElement as HTMLElement
                      if (btn) btn.innerText = 'Recalibrated!'
                      setTimeout(() => { if (btn) btn.innerText = 'Recalibrate' }, 1000)
                    }}
                    className="bg-black/40 backdrop-blur-md px-2 py-1 rounded border border-white/10 text-white/70 font-mono text-[10px] flex items-center gap-1 hover:text-white transition-colors"
                   >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                    Recalibrate
                   </button>
                </div>
              </div>

              <div className="flex flex-col items-center gap-2">
                <div className={`px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-lg border border-white/10 text-xs font-medium text-center shadow-2xl transform transition-all duration-300 ${status !== 'good' ? 'scale-110' : 'scale-100'}`}>
                  {FEEDBACK_MESSAGES[status]}
                </div>
              </div>
            </div>
          )}

          {showDevicePicker && (
            <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-md flex flex-col p-4 overflow-y-auto z-20">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400">Select Camera</h3>
                <button onClick={() => setShowDevicePicker(false)} className="text-slate-500 hover:text-white">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
              <div className="space-y-2">
                {devices.map((device) => (
                  <button
                    key={device.deviceId}
                    onClick={() => {
                      if (onDeviceChange) onDeviceChange(device.deviceId)
                      setShowDevicePicker(false)
                    }}
                    className={`w-full text-left p-3 rounded-xl border text-xs transition-all ${
                      selectedDeviceId === device.deviceId 
                        ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400' 
                        : 'bg-slate-800/50 border-slate-700/50 text-slate-400 hover:bg-slate-800'
                    }`}
                  >
                    {device.label || `Camera ${device.deviceId.slice(0, 5)}`}
                  </button>
                ))}
              </div>
            </div>
          )}

          {!isMonitoring && !showDevicePicker && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950/40 backdrop-blur-[2px]">
              <div className="w-12 h-12 rounded-full bg-slate-800/80 flex items-center justify-center mb-3">
                <svg className="w-6 h-6 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              </div>
              <span className="text-slate-400 text-sm font-semibold tracking-wide">Monitoring Paused</span>
            </div>
          )}
        </>
      )}
    </div>
  )
}
