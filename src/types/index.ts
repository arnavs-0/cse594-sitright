/* ────────────────────────────────────────────────────────── */
/*  Shared types for SitRight                                */
/* ────────────────────────────────────────────────────────── */

export type PostureStatus = 'good' | 'warning' | 'bad'

export interface PostureAlert {
  id: string
  timestamp: Date
  type: PostureStatus
  message: string
}

export interface PostureSnapshot {
  time: Date
  status: PostureStatus
  score: number
}

export type AlertMode = 'banner' | 'overlay' | 'both'

export interface AppSettings {
  notificationFrequency: 'immediate' | '10sec' | '30sec' | '5min' 
  alertMode: AlertMode
  sensitivity: number // 1–5
  soundEnabled: boolean
  startMinimized: boolean
  showInMenuBar: boolean
  deviceId?: string
}

/* Electron preload bridge */
export interface ElectronAPI {
  sendNotification: (title: string, body: string) => Promise<void>
  showOverlay: (status: string) => Promise<void>
  hideOverlay: () => Promise<void>
  platform: string
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}
