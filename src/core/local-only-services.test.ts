import { afterEach, expect, it, vi } from 'vitest'
import { fetchCheck, fetchPopupImage } from './check'
import { createPushNotify, createLiveUpdatePush, createHostAuthCache } from './push-notify'
import { createWatchLinkApi } from './watch-link/api'
import { createPushWebhookClient } from './push-webhook'
import { initLicense, getStoredEntitlement } from './license'
import { initProjectLimit } from './project-limit'
const h = vi.hoisted(() => ({ handlers: new Map<string, Function>() }))
vi.mock('./platform', () => ({ platform: () => ({ handle: (key: string, fn: Function) => h.handlers.set(key, fn) }) }))
afterEach(() => { vi.unstubAllGlobals(); h.handlers.clear() })
it('never contacts a cloud service or reads an entitlement, including with old settings enabled', async () => {
 const network = vi.fn(() => { throw Error('network forbidden') }); vi.stubGlobal('fetch', network)
 initLicense()
 expect(getStoredEntitlement()).toBeNull()
 const limits = initProjectLimit({ openProjects: () => 100, machineHash: vi.fn(), notify: vi.fn() })
 expect(limits.state().active).toBe(false)
 expect((await limits.claim()).ok).toBe(true)
 expect((await fetchCheck()).messages).toEqual([])
 expect(await fetchPopupImage('a'.repeat(64))).toBeNull()
 const deps = { env: { NODETERM_API_BASE: 'https://old-cloud.invalid' }, isPackaged: () => true, mobilePushEnabled: () => true } as any
 await createPushNotify(deps)._flushNow(); await createLiveUpdatePush(deps)._flushNow()
 expect(await createHostAuthCache({}).get({} as any)).toBe('drop')
 const links = createWatchLinkApi({ apiBase: 'https://old-cloud.invalid', fetch: network as any })
 expect((await links.create('old-token', 'hash', 60)).ok).toBe(false)
 expect(await links.revokeAll('old-token')).toBe(false)
 const hooks = createPushWebhookClient(deps)
 expect((await hooks.mint()).ok).toBe(false)
 expect(network).not.toHaveBeenCalled()
})
