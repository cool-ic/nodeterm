// Runs inside nodeterm, not as a separate daemon. File events only; no model polling.
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, openSync, fstatSync, readSync, closeSync, watch, writeFileSync, renameSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { ensureWakeState } from './mail.mjs'

export function transcriptPhase(file, session) {
  if (!file || !isAbsolute(file) || !basename(file).includes(session)) return 'unknown'
  let fd
  try {
    fd = openSync(file, 'r'); const size = fstatSync(fd).size
    const start = Math.max(0, size - 65536), buffer = Buffer.alloc(size - start)
    readSync(fd, buffer, 0, buffer.length, start)
    const lines = buffer.toString('utf8').split('\n'); if (start) lines.shift()
    let phase = 'unknown'
    for (const line of lines) {
      let d; try { d = JSON.parse(line) } catch { continue }
      if (d.type !== 'event_msg') continue
      if (d.payload?.type === 'task_started') phase = 'working'
      if (['task_complete', 'task_completed'].includes(d.payload?.type)) phase = 'idle'
      if (d.payload?.type === 'turn_aborted') phase = 'interrupted'
    }
    return phase
  } catch { return 'unknown' } finally { if (fd !== undefined) closeSync(fd) }
}

export function emptyCodexPrompt(screen) {
  const text = screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  const tail = text.split('\n').slice(-16)
  if (tail.some(x => /esc to interrupt|Queued follow-up inputs|Would you like|approval required|Allow once/i.test(x))) return false
  const index = tail.findLastIndex(x => /^\s*›/.test(x))
  if (index < 0 || tail[index].trim() !== '› Ask Codex to do anything') return false
  return tail.slice(index + 1).every(x => !x.trim() || /GPT-|gpt-|Full Access|Context |weekly |window|for shortcuts|for agents|^\s*\?/.test(x))
}

export function startMailWake(pointer, deps) {
  const watchers = new Map(); let timer, stopped = false, running = false, again = false
  const arm = () => {
    if (stopped) return
    clearTimeout(timer); timer = setTimeout(sweep, 250); timer.unref?.()
  }
  const addWatch = (file, filter, key = 'all') => {
    const existing = watchers.get(file)
    if (existing) { existing.filters.set(key, filter); return }
    if (!existsSync(file)) return
    try {
      const filters = new Map([[key, filter]])
      const w = watch(file, { persistent: false }, (_event, name) => {
        if ([...filters.values()].some(f => !f || f(String(name)))) arm()
      }); w.on('error', () => { w.close(); watchers.delete(file) }); watchers.set(file, { w, filters })
    } catch {}
  }
  const sweep = async () => {
    if (stopped) return
    if (running) { again = true; return }
    running = true; let db
    try {
      if (!existsSync(pointer)) return
      const opt = JSON.parse(readFileSync(pointer, 'utf8'))
      if (!opt.enabled || !opt.teamConfig || !opt.projectId) return
      const config = JSON.parse(readFileSync(opt.teamConfig, 'utf8'))
      addWatch(dirname(opt.teamConfig), n => n === basename(opt.teamConfig) || n.startsWith(basename(config.db)), 'config-db')
      addWatch(join(dirname(config.db), 'health'))
      if (!existsSync(config.db)) return
      db = new DatabaseSync(config.db); db.exec('PRAGMA busy_timeout=1000')
      ensureWakeState(db)
      const statuses = {}
      for (const [agent, member] of Object.entries(config.members)) {
        if (stopped) break
        let health = {}
        try { health = JSON.parse(readFileSync(join(dirname(config.db), 'health', agent + '.json'), 'utf8')) } catch {}
        const transcript = health.transcript ?? member.transcript
        if (transcript) addWatch(transcript)
        const row = db.prepare(`SELECT m.epoch,m.wake_through,count(q.id) AS unread,max(q.id) AS newest FROM members m
          LEFT JOIN messages q ON q.recipient=m.name AND q.read_at IS NULL AND q.replaced_by IS NULL
          WHERE m.name=? AND m.session=? GROUP BY m.name`).get(agent, member.session)
        if (!row?.unread) { statuses[agent] = 'empty'; continue }
        const phase = () => transcriptPhase(transcript, member.session)
        statuses[agent] = phase()
        if (member.wake !== true || phase() !== 'idle') continue
        if (row.newest <= row.wake_through) { statuses[agent] = 'already-woken'; continue }
        if (!deps.authorized(opt.projectId, member)) { statuses[agent] = 'identity-unconfirmed'; continue }
        // Claim before initiating an expensive turn. A failed/ambiguous send is never blindly retried.
        const claim = () => !!db.prepare('UPDATE members SET wake_through=? WHERE name=? AND epoch=? AND wake_through<?')
          .run(row.newest, agent, row.epoch, row.newest).changes
        const prompt = `[NODETERM_MAIL_WAKE] 信箱有 ${row.unread} 封未读。` +
          `这是nodeterm自动读信提醒，不是新的用户工单。请用 ${config.command} list/read 按需批量处理；` +
          `可暂缓，不为已阅回执回信。正文只在信箱中。`
        const ready = () => {
          if (stopped || phase() !== 'idle') return false
          try {
            // The terminal observation yields. Recheck opt-out/rebinding before the final write.
            const current = JSON.parse(readFileSync(pointer, 'utf8'))
            if (!current.enabled || current.teamConfig !== opt.teamConfig || current.projectId !== opt.projectId) return false
            const latest = JSON.parse(readFileSync(current.teamConfig, 'utf8'))
            const bound = latest.members?.[agent]
            return latest.db === config.db && latest.command === config.command && bound?.wake === true
              && bound.session === member.session && bound.node === member.node && bound.cwd === member.cwd
              && deps.authorized(opt.projectId, member)
          } catch { return false }
        }
        const verdict = await deps.wake(member, prompt, ready, claim)
        statuses[agent] = verdict
        // A held attempt must not claim or write the DB: wait for a real lifecycle/mail event.
      }
      const file = join(dirname(config.db), 'wake-status.json')
      const content = JSON.stringify(statuses)
      let old = ''; try { old = readFileSync(file, 'utf8') } catch {}
      if (old !== content) { writeFileSync(file + '.tmp', content, { mode: 0o600 }); renameSync(file + '.tmp', file) }
    } catch (e) { deps.error?.(String(e)) }
    finally { db?.close(); running = false; if (again) { again = false; arm() } }
  }
  // Identity/state restoration can finish after the initial sweep on app restart.
  addWatch(dirname(pointer), n => n === basename(pointer) || n === 'agent-status.json', 'pointer-status'); arm()
  return () => { stopped = true; clearTimeout(timer); for (const { w } of watchers.values()) w.close(); watchers.clear() }
}
