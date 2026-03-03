import { ReactNode } from 'react'
import Sidebar from './Sidebar'
import { Page } from '../App'
import { PostureStatus } from '../types'

interface Props {
  children: ReactNode
  currentPage: Page
  onNavigate: (page: Page) => void
  isMonitoring: boolean
  onToggleMonitoring: () => void
  postureStatus: PostureStatus
}

export default function Layout({
  children,
  currentPage,
  onNavigate,
  isMonitoring,
  onToggleMonitoring,
  postureStatus,
}: Props) {
  return (
    <div className="flex h-screen bg-slate-900">
      <Sidebar
        currentPage={currentPage}
        onNavigate={onNavigate}
        isMonitoring={isMonitoring}
        onToggleMonitoring={onToggleMonitoring}
        postureStatus={postureStatus}
      />

      <main className="flex-1 overflow-y-auto">
        {/* Draggable title bar */}
        <div className="titlebar-drag h-8 flex items-center justify-center bg-slate-900/50 backdrop-blur sticky top-0 z-10">
          <span className="text-[11px] text-slate-500 font-medium tracking-wide">SitRight</span>
        </div>

        <div className="p-6">{children}</div>
      </main>
    </div>
  )
}
