import { useState } from 'react'
import { usePosture } from './hooks/usePosture'
import { SettingsProvider, useSettings } from './hooks/useSettings'
import Layout from './components/Layout'
import Dashboard from './components/Dashboard'
import Settings from './components/Settings'

export type Page = 'dashboard' | 'settings'

function AppInner() {
  const [currentPage, setCurrentPage] = useState<Page>('dashboard')
  const { settings } = useSettings()
  const posture = usePosture(settings.alertMode, settings.notificationFrequency)

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
