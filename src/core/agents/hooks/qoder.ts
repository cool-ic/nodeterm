// Qoder CLI status-hook installer. Thin wrapper over the shared merge helper: Qoder's `hooks` block
// is Claude Code's shape — `{"<Event>": [{matcher?, hooks: [{type, command, timeout?}]}]}` — in a
// SHARED user settings file, so this goes through `installHooksInto` (guarded merge, preserves every
// foreign entry) exactly like claude and gemini, and NOT through copilot's own-file grammar.
//
// Everything below was measured against the installed `qodercli` 1.1.67 on this host (2026-10-10);
// docs/qoder-agent.md carries the commands and the raw payloads.
//   - The config root is `~/.qoder` (its `globalConfigDirOverride` path). The layout mirrors Claude
//     Code: `settings.json`, `skills/`, `commands/`, `agents/`, `output-styles/`, and transcripts at
//     `projects/<slug>/<session_id>.jsonl`.
//   - A hook written into `<configDir>/settings.json` FIRES (verified live: the managed-shaped entry
//     in a scratch config dir received `SessionStart` and `Notification` payloads on stdout's stdin
//     channel, snake_case, Claude's field names).
//
// Why NOT `$QODER_CONFIG_DIR` (which claude's installer's `$CLAUDE_CONFIG_DIR` counterpart would
// suggest): measured in the binary, that variable is (a) exported BY the CLI to the commands it
// spawns, as `v.getGlobalConfigDir()`, and (b) read only to find `<dir>/bin` on PATH for external
// commands — never as a config-root override. Honoring it would let a stray value in the app's own
// environment send our hooks to a directory the CLI never reads, which is a silent total failure
// (no badge, no session name, no notification, ever). The only override the CLI actually honors is
// its own `--config-dir` FLAG, which is per-invocation and cannot be satisfied by a machine-level
// install; a user who runs Qoder that way gets the same "no status" outcome every hook integration
// has, and the honest answer is a documented boundary rather than a guess.
import { homedir } from 'os'
import path from 'path'
import { QODER_HOOK_EVENTS } from '@shared/agents/hook-events'
import { installHooksInto, removeHooksFrom } from './install-helper'

const SCRIPT_FILE_NAME = 'qoder.sh'

/** Qoder's user-level config root (`~/.qoder`). One home for the hook file and the skills dir, so
 *  the installer and `agent-integrations.skillRootsFor` cannot disagree about where it lives. */
export function qoderConfigDir(home: string = homedir()): string {
  return path.join(home, '.qoder')
}

/** The shared settings file our `hooks` block is merged into. */
export function qoderSettingsPath(home: string = homedir()): string {
  return path.join(qoderConfigDir(home), 'settings.json')
}

export function installQoderHooks(): void {
  installHooksInto({
    agentId: 'qoder',
    scriptFileName: SCRIPT_FILE_NAME,
    configPath: qoderSettingsPath(),
    events: QODER_HOOK_EVENTS
  })
}

export function removeQoderHooks(): void {
  removeHooksFrom({
    configPath: qoderSettingsPath(),
    events: QODER_HOOK_EVENTS,
    scriptFileName: SCRIPT_FILE_NAME
  })
}
