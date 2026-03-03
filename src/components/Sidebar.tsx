import { Page } from '../App'
import { PostureStatus } from '../types'

interface Props {
  currentPage: Page
  onNavigate: (page: Page) => void
  isMonitoring: boolean
  onToggleMonitoring: () => void
  postureStatus: PostureStatus
}

const statusDot: Record<PostureStatus, string> = {
  good: 'bg-emerald-500',
  warning: 'bg-amber-500',
  bad: 'bg-red-500',
}

export default function Sidebar({
  currentPage,
  onNavigate,
  isMonitoring,
  onToggleMonitoring,
  postureStatus,
}: Props) {
  return (
    <div className="w-16 bg-slate-950 border-r border-slate-800 flex flex-col items-center py-4 gap-2">
      {/* Title-bar drag spacer */}
      <div className="titlebar-drag h-4 w-full" />

      {/* Live status dot */}
      <div className="mb-4 relative">
        <div
          className={`w-3 h-3 rounded-full transition-colors duration-500 ${
            isMonitoring ? statusDot[postureStatus] : 'bg-slate-600'
          }`}
        />
        {isMonitoring && (
          <div
            className={`absolute inset-0 w-3 h-3 rounded-full ${statusDot[postureStatus]} animate-ping opacity-75`}
          />
        )}
      </div>

      {/* Nav — Dashboard */}
      <NavBtn
        active={currentPage === 'dashboard'}
        onClick={() => onNavigate('dashboard')}
        title="Dashboard"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      </NavBtn>

      {/* Nav — Settings */}
      <NavBtn
        active={currentPage === 'settings'}
        onClick={() => onNavigate('settings')}
        title="Settings"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </NavBtn>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Monitoring toggle */}
      <button
        onClick={onToggleMonitoring}
        className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-200 ${
          isMonitoring
            ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
            : 'bg-slate-800 text-slate-500 hover:bg-slate-700'
        }`}
        title={isMonitoring ? 'Pause Monitoring' : 'Resume Monitoring'}
      >
        {isMonitoring ? (
          /* eye open */
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        ) : (
          /* eye closed */
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
            <path d="m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        )}
      </button>

      <div className="mb-2" />
    </div>
  )
}

/* ── nav button ── */
function NavBtn({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-200 ${
        active
          ? 'bg-indigo-500/20 text-indigo-400'
          : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
      }`}
    >
      {children}
    </button>
  )
}
