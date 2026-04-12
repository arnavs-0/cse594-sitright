import { createContext, useContext, useState, useCallback, ReactNode } from 'react'
import { AppSettings, AlertMode } from '../types'

const defaults: AppSettings = {
  notificationFrequency: '10sec',
  alertMode: 'overlay',
  sensitivity: 3,
  soundEnabled: true,
  startMinimized: false,
  showInMenuBar: true,
  deviceId: '',
}

interface SettingsContextValue {
  settings: AppSettings
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  alertMode: AlertMode
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(defaults)

  const update = useCallback(
    <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
      setSettings((prev) => ({ ...prev, [key]: value })),
    [],
  )

  return (
    <SettingsContext.Provider value={{ settings, update, alertMode: settings.alertMode }}>
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used inside <SettingsProvider>')
  return ctx
}
