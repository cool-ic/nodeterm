import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/unused-local-only-test', isPackaged: true }, ipcMain: { on: vi.fn(), handle: vi.fn() }, safeStorage: {}, webContents: { fromId: vi.fn() } }))
import { connectRelayClient } from './relay-client'
import { joinHostedTeam } from './hosted-join'
import { relayAllowed, mintPairingToken } from './host-service'
it('refuses old cloud offers and bookmarks before opening any transport or loading credentials', async () => {
 const read = vi.fn(() => { throw Error('credentials must not be read') })
 const options = new Proxy({}, { get: read })
 expect(() => connectRelayClient(options as any)).toThrow('not supported')
 await expect(joinHostedTeam('old-bookmark', options as any, options as any)).rejects.toThrow('not supported')
 expect(read).not.toHaveBeenCalled()
 expect(relayAllowed()).toBe(false)
 await expect(mintPairingToken('old-token')).rejects.toThrow('removed')
})
