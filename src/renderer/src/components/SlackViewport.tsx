import { useEffect, useRef } from 'react'
import { boundsEqual, createRafThrottle } from '../lib/perf'

interface SlackViewportProps {
  hasActiveProfile: boolean
  onBoundsChange: (bounds: { x: number; y: number; width: number; height: number }) => void
}

export function SlackViewport({
  hasActiveProfile,
  onBoundsChange
}: SlackViewportProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const last = useRef<{ x: number; y: number; width: number; height: number } | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) {
      return
    }

    const publish = createRafThrottle(
      (bounds: { x: number; y: number; width: number; height: number }) => {
        if (boundsEqual(last.current, bounds)) return
        last.current = bounds
        onBoundsChange(bounds)
      }
    )

    const report = (): void => {
      const rect = el.getBoundingClientRect()
      publish({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      })
    }

    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    window.addEventListener('resize', report)

    return () => {
      publish.cancel()
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [onBoundsChange])

  return (
    <div className="slack-viewport" ref={ref} data-testid="slack-viewport">
      {!hasActiveProfile ? (
        <div className="viewport-placeholder">
          <h1>Embed</h1>
          <p>Select Slack, Teams, or WhatsApp under a profile.</p>
        </div>
      ) : null}
    </div>
  )
}
