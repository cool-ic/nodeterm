// The local-only fork retires the service without silently deleting historical user data.
// Neither shell may call the destructive cleanup automatically.
import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const read = (rel: string): string => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n')

describe('retired live-link data cleanup wiring', () => {
  it('the desktop preserves historical userData', () => {
    const src = read('main/index.ts')
    expect(src).not.toContain('removeRetiredLiveLinkData(corePlatform.userDataDir')
  })

  it('the Server Edition preserves historical data', () => {
    const src = read('server/index.ts')
    expect(src).not.toContain('removeRetiredLiveLinkData(config.dataDir')
  })

  it('neither shell boots the live-link service or its store', () => {
    for (const shell of ['main/index.ts', 'server/index.ts']) {
      const src = read(shell)
      expect(src, shell).not.toContain('createWatchLinkService')
      expect(src, shell).not.toContain('WatchLinkStore')
      expect(src, shell).not.toContain("watch-links.json'")
    }
  })
})
