import { afterEach, expect, it, vi } from 'vitest'
import { TypewriterSounds } from './sound-engine'
const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {} })
const node = (): any => ({ gain: param(), frequency: param(), Q: param(), playbackRate: param(), pan: param(), connect(to: any) { return to }, disconnect() {}, start() {}, stop() {} })
function offline(pending = false) {
  const releases: Array<() => void> = []
  let count = 0
  vi.stubGlobal('OfflineAudioContext', class {
    sampleRate: number; destination = node()
    constructor(_channels: number, public length: number, rate: number) { count++; this.sampleRate = rate }
    createGain = node; createBufferSource = node; createBiquadFilter = node; createOscillator = node
    createBuffer(channels: number, size: number) { const data = Array.from({ length: channels }, () => new Float32Array(size)); return { getChannelData: (i: number) => data[i] } }
    startRendering() { return pending ? new Promise<any>((r) => releases.push(() => r({}))) : Promise.resolve({}) }
  })
  return { count: () => count, releases }
}
afterEach(() => vi.unstubAllGlobals())
it('renders only the four terminal strikes once, across repeated volume updates and device closes', async () => {
  const mock = offline(), engine = new TypewriterSounds(['key', 'space', 'return', 'backspace'])
  await engine.prepare('standard')
  expect(mock.count()).toBe(16)
  for (const volume of [.2, .3, .4, .5]) {
    engine.configure({ sound: true, volume, voice: 'standard', variation: .65 })
    engine.close()
  }
  await engine.prepare('standard')
  expect(mock.count()).toBe(16)
  engine.dispose()
})
it('disposal stops further variants when in-flight offline rendering completes', async () => {
  const mock = offline(true), engine = new TypewriterSounds(['key', 'space', 'return', 'backspace'])
  const work = engine.prepare('standard')
  expect(mock.count()).toBe(4)
  engine.dispose()
  mock.releases.forEach((release) => release())
  await work
  expect(mock.count()).toBe(4)
})
