import { it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { terminalCliScript, ensureTerminalZsh, ensureTerminalCliBin } from './terminal-cli'
import { testTmpDir } from './test-tmp'

function run(agent: 'codex' | 'qoder', args: string[], supports = true) {
  const dir = testTmpDir('cli-entry-')
  const real = path.join(dir, "real cli's binary"), wrapper = path.join(dir, 'entry')
  fs.writeFileSync(real, `#!/bin/sh\nif [ "$1" = --help ]; then ${supports ? "printf '%s\\n' '      --no-daemon'" : ':'}; exit 0; fi\nprintf '%s\\n' "$NODETERM_NODE_ID" "$NODETERM_AGENT_ID" "$@"\n`, { mode: 0o700 })
  fs.writeFileSync(wrapper, terminalCliScript(agent, real), { mode: 0o700 })
  return execFileSync('/bin/sh', [wrapper, ...args], {
    env: { ...process.env, NODETERM_NODE_ID: 'own-node', NODETERM_AGENT_ID: 'stale-agent' }, encoding: 'utf8'
  }).trim().split('\n')
}
it.skipIf(process.platform === 'win32')('keeps an existing destination intact and cleans the temporary script when publication fails', () => {
  const root = testTmpDir('cli-publication-'), bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const destination = path.join(root, 'terminal-cli', 'codex')
  fs.mkdirSync(destination, { recursive: true })
  fs.writeFileSync(path.join(destination, 'keep'), 'existing data')
  expect(() => ensureTerminalCliBin(root, bin)).toThrow()
  expect(fs.readFileSync(path.join(destination, 'keep'), 'utf8')).toBe('existing data')
  expect(fs.readdirSync(path.dirname(destination))).toEqual(['codex'])
})
it.skipIf(process.platform === 'win32')('isolates plain Codex while preserving this pane and literal arguments', () => {
  expect(run('codex', ['resume', 'session-id', 'hello $world; `code`']))
    .toEqual(['own-node', 'codex', '--no-daemon', 'resume', 'session-id', 'hello $world; `code`'])
})
it.skipIf(process.platform === 'win32')('does not conflict with an explicit remote or duplicate no-daemon', () => {
  expect(run('codex', ['--remote', 'unix:///test'])).toEqual(['own-node', 'codex', '--remote', 'unix:///test'])
  expect(run('codex', ['--no-daemon'])).toEqual(['own-node', 'codex', '--no-daemon'])
  expect(run('codex', ['--', '--remote'])).toEqual(['own-node', 'codex', '--no-daemon', '--', '--remote'])
})
it.skipIf(process.platform === 'win32')('does not give old Codex or Qoder an unsupported flag', () => {
  expect(run('codex', ['hello'], false)).toEqual(['own-node', 'codex', 'hello'])
  expect(run('qoder', ['--model', 'auto'])).toEqual(['own-node', 'qoder', '--model', 'auto'])
})

it.skipIf(!fs.existsSync('/bin/zsh'))('keeps the managed CLI after a zsh startup tool reorders PATH', () => {
  const root = testTmpDir('zsh-entry-'), bin = path.join(root, 'bin'), user = path.join(root, 'user'), other = path.join(root, 'other')
  for (const p of [bin, user, other]) fs.mkdirSync(p)
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nprintf managed\n', { mode: 0o700 })
  fs.writeFileSync(path.join(other, 'codex'), '#!/bin/sh\nprintf wrong-daemon\n', { mode: 0o700 })
  fs.writeFileSync(path.join(user, '.zshrc'), `precmd() { export PATH='${other}':$PATH; }\n`)
  const zdotdir = ensureTerminalZsh(root, bin)
  const env = { ...process.env, ZDOTDIR: zdotdir, NODETERM_USER_ZDOTDIR: user }
  expect(execFileSync('/bin/zsh', ['-ic', 'precmd; codex'], { env, encoding: 'utf8' })).toBe('managed')
  // A user's explicit customization is preserved; it is outside the managed entry guarantee.
  fs.writeFileSync(path.join(user, '.zshrc'), 'function codex() { printf customized; }\n')
  expect(execFileSync('/bin/zsh', ['-ic', 'codex'], { env, encoding: 'utf8' })).toBe('customized')
})
