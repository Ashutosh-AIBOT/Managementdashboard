import { APP_DISPLAY_NAME } from '../../../shared/brand'

interface LockOverlayProps {
  unlocking: boolean
  onUnlock: () => void
}

export function LockOverlay({ unlocking, onUnlock }: LockOverlayProps): React.JSX.Element {
  return (
    <div className="lock-overlay" role="dialog" aria-label="App locked">
      <div className="lock-card">
        <h1>{APP_DISPLAY_NAME}</h1>
        <p>Locked. Use Touch ID to continue.</p>
        <button type="button" className="btn primary" disabled={unlocking} onClick={onUnlock}>
          {unlocking ? 'Waiting for Touch ID…' : 'Unlock'}
        </button>
      </div>
    </div>
  )
}
