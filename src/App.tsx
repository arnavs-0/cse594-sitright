import { useState } from 'react'
import { usePosture } from './hooks/usePosture'
import { SettingsProvider, useSettings } from './hooks/useSettings'
import Layout from './components/Layout'
import Dashboard from './components/Dashboard'
import Settings from './components/Settings'

export type Page = 'dashboard' | 'settings'

function AppInner() {
  const [currentPage, setCurrentPage] = useState<Page>('dashboard')
  const { alertMode } = useSettings()
  const posture = usePosture(alertMode)

  return (
    <Layout
      currentPage={currentPage}
      onNavigate={setCurrentPage}
      isMonitoring={posture.isMonitoring}
      onToggleMonitoring={posture.toggleMonitoring}
      postureStatus={posture.status}
    >
      {currentPage === 'dashboard' ? (
        <Dashboard posture={posture} />
      ) : (
        <Settings />
      )}
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
