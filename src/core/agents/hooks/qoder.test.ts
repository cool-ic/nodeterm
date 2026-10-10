import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { QODER_HOOK_EVENTS } from '@shared/agents/hook-events'

// The installer resolves BOTH the config root and the managed script path from HOME, so the whole
// test runs inside a temp home (same shape as claude/grok/copilot's).
let home = ''

vi.mock('os', async (orig) => {
  const real = (await orig()) as typeof import('os')
  return {
    ...real,
    default: { ...real, homedir: () => home },
    homedir: () => home
  }
})

type HookDef = { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }

describe('qoder hook installer', () => {
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'nt-qoder-home-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    vi.resetModules()
  })

  const read = (p: string): { hooks: Record<string, HookDef[]>; [k: string]: unknown } =>
    JSON.parse(readFileSync(p, 'utf8'))

  it("merges our handler into Qoder's OWN user settings.json, in Claude's hook shape", async () => {
    const { qoderSettingsPath, installQoderHooks } = await import('./qoder')
    expect(qoderSettingsPath()).toBe(path.join(home, '.qoder', 'settings.json'))
    installQoderHooks()

    const cfg = read(qoderSettingsPath())
    expect(Object.keys(cfg.hooks).sort()).toEqual([...QODER_HOOK_EVENTS].sort())
    // `{matcher?, hooks: [{type, command}]}` under the EVENT key — Qoder's schema, which is why this
    // routes through the shared merge helper instead of copilot's flat `{type, bash}` grammar.
    const start = cfg.hooks.SessionStart
    expect(start).toHaveLength(1)
    expect(start[0].matcher).toBeUndefined()
    expect(start[0].hooks).toHaveLength(1)
    expect(start[0].hooks[0].type).toBe('command')
    expect(start[0].hooks[0].command).toContain(
      path.join(home, '.nodeterm', 'agent-hooks', 'qoder.sh')
    )
    // The guarded form: a missing script drains stdin and exits 0 instead of blocking a prompt.
    expect(start[0].hooks[0].command).toMatch(/^if \[ -r /)
    expect(start[0].hooks[0].timeout).toBeUndefined()

    // The shared script is the REAL managed script, and it posts to qoder's own hook route.
    expect(readFileSync(path.join(home, '.nodeterm', 'agent-hooks', 'qoder.sh'), 'utf8')).toContain(
      '/hook/qoder'
    )
  })

  it('preserves a foreign hook and every unrelated settings key, and is idempotent', async () => {
    const { qoderSettingsPath, installQoderHooks } = await import('./qoder')
    mkdirSync(path.dirname(qoderSettingsPath()), { recursive: true })
    writeFileSync(
      qoderSettingsPath(),
      JSON.stringify({
        permissions: { trustDirectories: ['/Volumes/work'] },
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] }
      })
    )

    installQoderHooks()
    installQoderHooks()

    const cfg = read(qoderSettingsPath())
    expect(cfg.permissions).toEqual({ trustDirectories: ['/Volumes/work'] })
    // One of ours AND the user's own, in the same event — never a replacement.
    expect(cfg.hooks.UserPromptSubmit).toHaveLength(2)
    const commands = cfg.hooks.UserPromptSubmit.map((d) => d.hooks[0].command)
    expect(commands).toContain('echo mine')
    expect(commands.filter((c) => c.includes('qoder.sh'))).toHaveLength(1)
    for (const ev of QODER_HOOK_EVENTS) {
      expect(cfg.hooks[ev].filter((d) => d.hooks.some((h) => h.command.includes('qoder.sh'))),
        ev).toHaveLength(1)
    }
  })

  it('remove strips only our handlers and leaves the file valid', async () => {
    const { qoderSettingsPath, installQoderHooks, removeQoderHooks } = await import('./qoder')
    installQoderHooks()
    removeQoderHooks()

    const cfg = read(qoderSettingsPath())
    expect(cfg.hooks).toEqual({})
  })

  it('reads the config root from HOME only — never from $QODER_CONFIG_DIR', async () => {
    // MEASURED in the 1.1.67 binary: QODER_CONFIG_DIR is EXPORTED to child processes by the CLI and
    // read only to find `<dir>/bin` for external commands; the config root override the CLI honors
    // is its own `--config-dir` flag. Honoring the env var here would let a stray value send our
    // hooks somewhere Qoder never reads — a silent, total integration failure.
    process.env.QODER_CONFIG_DIR = path.join(home, 'elsewhere')
    try {
      const { qoderSettingsPath, installQoderHooks } = await import('./qoder')
      installQoderHooks()
      expect(qoderSettingsPath()).toBe(path.join(home, '.qoder', 'settings.json'))
      expect(read(qoderSettingsPath()).hooks.SessionStart).toHaveLength(1)
    } finally {
      delete process.env.QODER_CONFIG_DIR
    }
  })
})
