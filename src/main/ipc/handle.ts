import { ipcMain } from 'electron'

/**
 * Thin wrapper so domain modules never import ipcMain directly for registration
 * beyond this helper — keeps IPC wiring consistent.
 */
export function handleInvoke<TPayload, TResult>(
  channel: string,
  handler: (payload: TPayload) => Promise<TResult> | TResult
): void {
  ipcMain.handle(channel, async (_event, payload: TPayload) => handler(payload))
}
