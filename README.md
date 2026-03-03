# SitRight — AI-Powered Posture Monitoring

A lightweight desktop application that uses your webcam to detect and correct poor posture in real time.

## Tech Stack

- **Electron** — cross-platform desktop shell
- **React 18 + TypeScript** — UI framework
- **Vite** — fast build tooling
- **Tailwind CSS** — utility-first styling

## Quick Start

```bash
npm install
npm run dev        # launches Electron + Vite dev server
```

## Production Build

```bash
npm run build
```

## Project Structure

```
electron/          Electron main process & preload
src/
  components/      React UI components
  hooks/           Custom hooks (posture data integration point)
  types/           Shared TypeScript types
```

## Demo Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| ⌘/Ctrl + 1 | Set posture → **Good** |
| ⌘/Ctrl + 2 | Set posture → **Warning** |
| ⌘/Ctrl + 3 | Set posture → **Bad** (triggers desktop notification) |

## Integration

The posture detection model plugs into `src/hooks/usePosture.ts`.
Replace the `simulatePosture` callback with real detection data — the
rest of the UI reads from the same hook interface automatically.