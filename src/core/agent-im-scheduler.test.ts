import { afterEach, expect, it, vi } from 'vitest'
import { ImWakeScheduler } from './agent-im-scheduler'
afterEach(() => vi.useRealTimers())
it('batches quiet bursts and runs again after the next request', () => {
  vi.useFakeTimers(); const run = vi.fn(); const scheduler = new ImWakeScheduler(run)
  scheduler.request(); vi.advanceTimersByTime(100); scheduler.request()
  vi.advanceTimersByTime(199); expect(run).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1); expect(run).toHaveBeenCalledTimes(1)
  scheduler.request(); vi.advanceTimersByTime(200); expect(run).toHaveBeenCalledTimes(2)
  vi.advanceTimersByTime(2000); expect(run).toHaveBeenCalledTimes(2)
  scheduler.dispose()
})
it('continuous output cannot postpone another member forever', () => {
  vi.useFakeTimers(); const run = vi.fn(); const scheduler = new ImWakeScheduler(run)
  for (let i = 0; i < 100; i++) { scheduler.request(); vi.advanceTimersByTime(100) }
  expect(run).toHaveBeenCalledTimes(10)
  expect(vi.getTimerCount()).toBe(0)
  scheduler.dispose()
})
it('quit cancels both pending timers and ignores late requests', () => {
  vi.useFakeTimers(); const run = vi.fn(); const scheduler = new ImWakeScheduler(run)
  scheduler.request(); scheduler.dispose(); scheduler.request(); vi.advanceTimersByTime(5000)
  expect(run).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
})
