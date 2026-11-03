import { afterEach, describe, expect, it } from 'vitest'
import {
  CANVAS_LOCK_KEY,
  parseCanvasLocked,
  readCanvasLocked,
  writeCanvasLocked
} from './canvasLock'
import { constrainCanvasPan, constrainPanDelta, parseCanvasLockMode, readCanvasLockMode, writeCanvasLockMode, toggleCanvasLockMode } from './canvasLock'

const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

function installStorage(impl: Partial<Storage>): void {
  Object.defineProperty(globalThis, 'localStorage', { value: impl, configurable: true })
}

function memoryStorage(seed: Record<string, string> = {}): { store: Record<string, string> } {
  const store = { ...seed }
  installStorage({
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v
    }
  } as Partial<Storage>)
  return { store }
}

afterEach(() => {
  if (real) Object.defineProperty(globalThis, 'localStorage', real)
  else delete (globalThis as { localStorage?: unknown }).localStorage
})

describe('directional camera locks', () => {
  it('keeps legacy values and round-trips all four modes in the same personal key', () => {
    const { store } = memoryStorage()
    expect(parseCanvasLockMode('1')).toBe('all')
    expect(parseCanvasLockMode('0')).toBe('none')
    expect(parseCanvasLockMode('unknown')).toBe('none')
    for (const mode of ['none', 'horizontal', 'vertical', 'all'] as const) {
      writeCanvasLockMode(mode)
      expect(readCanvasLockMode()).toBe(mode)
      expect(Object.keys(store)).toEqual([CANVAS_LOCK_KEY])
    }
  })
  it('switches directly between modes and toggles the active one off', () => {
    expect(toggleCanvasLockMode('all', 'horizontal')).toBe('horizontal')
    expect(toggleCanvasLockMode('horizontal', 'vertical')).toBe('vertical')
    expect(toggleCanvasLockMode('vertical', 'all')).toBe('all')
    expect(toggleCanvasLockMode('horizontal', 'horizontal')).toBe('none')
  })
  it('projects diagonal gestures onto the allowed axis without drift', () => {
    let horizontal = { x: 42, y: 19, zoom: 1 }
    let vertical = { ...horizontal }
    for (let i = 0; i < 20; i++) {
      horizontal = constrainCanvasPan({ ...horizontal, x: horizontal.x + 7, y: horizontal.y - 4 }, horizontal, 'horizontal')
      vertical = constrainCanvasPan({ ...vertical, x: vertical.x + 7, y: vertical.y - 4 }, vertical, 'vertical')
    }
    expect(horizontal).toEqual({ x: 42, y: -61, zoom: 1 })
    expect(vertical).toEqual({ x: 182, y: 19, zoom: 1 })
  })
  it('leaves zoom anchoring and the unlocked path unchanged', () => {
    const previous = { x: 42, y: 19, zoom: 1 }, next = { x: 18, y: 33, zoom: 1 }
    expect(constrainCanvasPan(next, previous, 'none')).toBe(next)
    const zoom = { x: -42, y: -19, zoom: 2 }
    expect(constrainCanvasPan(zoom, previous, 'horizontal')).toBe(zoom)
    expect(constrainCanvasPan(zoom, previous, 'vertical')).toBe(zoom)
  })
  it('projects edge auto-pan onto the allowed axis too', () => {
    expect(constrainPanDelta({ x: -8, y: 12 }, 'horizontal')).toEqual({ x: 0, y: 12 })
    expect(constrainPanDelta({ x: -8, y: 12 }, 'vertical')).toEqual({ x: -8, y: 0 })
  })
})

describe('parseCanvasLocked', () => {
  it('is off unless the flag is exactly 1', () => {
    expect(parseCanvasLocked(null)).toBe(false)
    expect(parseCanvasLocked('')).toBe(false)
    expect(parseCanvasLocked('0')).toBe(false)
    expect(parseCanvasLocked('true')).toBe(false)
    expect(parseCanvasLocked('1')).toBe(true)
  })
})

describe('readCanvasLocked / writeCanvasLocked', () => {
  it('round-trips the lock through the namespaced key', () => {
    const { store } = memoryStorage()
    expect(readCanvasLocked()).toBe(false)

    writeCanvasLocked(true)
    expect(store[CANVAS_LOCK_KEY]).toBe('1')
    expect(readCanvasLocked()).toBe(true)

    // Unlocking must persist too, or a lock could never be cleared for the next launch.
    writeCanvasLocked(false)
    expect(store[CANVAS_LOCK_KEY]).toBe('0')
    expect(readCanvasLocked()).toBe(false)
  })

  it('restores a lock written by a previous launch', () => {
    memoryStorage({ [CANVAS_LOCK_KEY]: '1' })
    expect(readCanvasLocked()).toBe(true)
  })

  it('reads unlocked when storage throws, and a failed write never throws', () => {
    installStorage({
      getItem: () => {
        throw new Error('private mode')
      },
      setItem: () => {
        throw new Error('quota')
      }
    } as Partial<Storage>)

    expect(readCanvasLocked()).toBe(false)
    expect(() => writeCanvasLocked(true)).not.toThrow()
  })

  it('reads unlocked when localStorage exists but has no methods (Node global, #412)', () => {
    installStorage({} as Partial<Storage>)
    expect(readCanvasLocked()).toBe(false)
    expect(() => writeCanvasLocked(true)).not.toThrow()
  })
})
