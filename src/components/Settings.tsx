import { AppSettings } from '../types'
import { useSettings } from '../hooks/useSettings'

export default function Settings() {
  const { settings, update: set } = useSettings()

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-100">Settings</h2>
        <p className="text-sm text-slate-500 mt-1">
          Configure how SitRight monitors and alerts you.
        </p>
      </div>

      {/* ── Notifications ── */}
      <Section title="Notifications" desc="Control how and when you receive posture alerts">
        <Row label="Alert Frequency" desc="How often to send alerts when posture is poor">
          <select
            value={settings.notificationFrequency}
            onChange={(e) =>
              set('notificationFrequency', e.target.value as AppSettings['notificationFrequency'])
            }
            className="bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-slate-200 outline-none focus:border-indigo-500 transition-colors"
          >
            <option value="immediate">Immediate</option>
            <option value="10sec">Every 10 seconds</option>
            <option value="30sec">Every 30 seconds</option>
            <option value="5min">Every 5 minutes</option>
          </select>
        </Row>

        <Row label="Sound" desc="Play a sound with notifications">
          <Toggle checked={settings.soundEnabled} onChange={(v) => set('soundEnabled', v)} />
        </Row>

        <Row label="Alert Style" desc="How posture alerts appear on your screen">
          <select
            value={settings.alertMode}
            onChange={(e) =>
              set('alertMode', e.target.value as AppSettings['alertMode'])
            }
            className="bg-slate-700 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-slate-200 outline-none focus:border-indigo-500 transition-colors"
          >
            <option value="overlay">Screen edge glow (subtle)</option>
            <option value="banner">System notification banner</option>
            <option value="both">Both</option>
          </select>
        </Row>
      </Section>

      {/* ── Detection ── */}
      <Section title="Detection" desc="Adjust posture detection sensitivity">
        <Row label="Sensitivity" desc="Higher values detect smaller posture deviations">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min="1"
              max="5"
              value={settings.sensitivity}
              onChange={(e) => set('sensitivity', Number(e.target.value))}
              className="w-24 accent-indigo-500"
            />
            <span className="text-sm text-slate-300 w-4 text-center">{settings.sensitivity}</span>
          </div>
        </Row>
      </Section>

      {/* ── General ── */}
      <Section title="General" desc="Application behavior settings">
        <Row label="Start Minimized" desc="Launch SitRight minimized to the system tray">
          <Toggle checked={settings.startMinimized} onChange={(v) => set('startMinimized', v)} />
        </Row>
        <Row label="Menu Bar Icon" desc="Show SitRight status in the menu bar">
          <Toggle checked={settings.showInMenuBar} onChange={(v) => set('showInMenuBar', v)} />
        </Row>
      </Section>
    </div>
  )
}

/* ── Helper sub-components ─────────────────────────────── */

function Section({
  title,
  desc,
  children,
}: {
  title: string
  desc: string
  children: React.ReactNode
}) {
  return (
    <div className="bg-slate-800/50 border border-slate-700/50 rounded-2xl p-5">
      <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
      <p className="text-[11px] text-slate-500 mb-4">{desc}</p>
      <div className="space-y-4">{children}</div>
    </div>
  )
}

function Row({
  label,
  desc,
  children,
}: {
  label: string
  desc: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <div className="text-sm text-slate-300">{label}</div>
        <div className="text-[11px] text-slate-500">{desc}</div>
      </div>
      {children}
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`relative w-10 h-[22px] rounded-full transition-colors duration-200 ${
        checked ? 'bg-indigo-500' : 'bg-slate-600'
      }`}
    >
      <div
        className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white transition-transform duration-200 ${
          checked ? 'translate-x-[18px]' : ''
        }`}
      />
    </button>
  )
}

