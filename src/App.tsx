import { useState } from 'react'
import { usePosture } from './hooks/usePosture'
import { SettingsProvider, useSettings } from './hooks/useSettings'
import Layout from './components/Layout'
import Dashboard from './components/Dashboard'
import Settings from './components/Settings'

export type Page = 'dashboard' | 'settings'

function getEffectiveAlertMode(settings: ReturnType<typeof useSettings>['settings']) {
  if (settings.overlayEnabled) return settings.alertMode
  if (settings.alertMode === 'both') return 'banner'
  if (settings.alertMode === 'overlay') return 'none'
  return settings.alertMode
}

function AppInner() {
  const [currentPage, setCurrentPage] = useState<Page>('dashboard')
  const { settings } = useSettings()
  const posture = usePosture(getEffectiveAlertMode(settings), settings.notificationFrequency)

  return (
    <Layout
      currentPage={currentPage}
      onNavigate={setCurrentPage}
      isMonitoring={posture.isMonitoring}
      onToggleMonitoring={posture.toggleMonitoring}
      postureStatus={posture.status}
    >
      <div className={currentPage === 'dashboard' ? 'block' : 'hidden'}>
        <Dashboard posture={posture} setVideo={posture.setVideo} />
      </div>
      <div className={currentPage === 'settings' ? 'block' : 'hidden'}>
        <Settings />
      </div>
    </Layout>
  )
}

function App() {
  return (
    <SettingsProvider>
      <AppInner />
    </SettingsProvider>
  )
}

export default App
