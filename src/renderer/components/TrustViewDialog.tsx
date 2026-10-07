import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDialogStack } from './dialog-stack'
import type { TrustSnapshot } from '../../shared/types'

/**
 * T201 — the read-only trust view. Lists the surviving agent nodes of ONE project and, for each,
 * whether the runtime ownership ledger can vouch for the pane this run, and why not when it
 * cannot (no durable row / entry-id mismatch / session gone / host unwired). Deliberately no
 * action surface: the T198 design rejected a vouch button, and a diagnostic that could grant
 * trust would be exactly that button with extra steps.
 */

const REASON_TEXT: Record<TrustSnapshot['rows'][number]['reason'], string> = {
  proven: '已证明：本轮 fresh spawn，或 attach 再证明（持久行 entry id 匹配）',
  'session-gone': '会话已亡：没有活着的 tmux 会话可投递（重新打开节点会以 fresh spawn 重记）',
  'no-durable-row': '无持久行：attach 还原且本机没有它的 spawn 记录（T198 之前的旧节点）',
  'entry-id-mismatch': 'entry id 不匹配：持久行属于另一个项目——克隆/伪造文件，按设计拒绝',
  'reproof-pending': '待再证明：持久行匹配本项目，但该 pane attach 早于记账生效；下次重新打开项目即恢复',
  'ownership-unwired': '宿主未接持久账本（T198 未生效），按旧规则 fail-closed'
}

const REASON_BADGE: Record<TrustSnapshot['rows'][number]['reason'], string> = {
  proven: '已证明',
  'session-gone': '会话已亡',
  'no-durable-row': '无持久行',
  'entry-id-mismatch': 'entry id 不匹配',
  'reproof-pending': '待再证明',
  'ownership-unwired': '未接线'
}

export function TrustViewDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const isTop = useDialogStack()
  const [snap, setSnap] = useState<TrustSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setSnap(await window.nodeTerminal.agentMessage.trust.snapshot(projectId))
    } catch (e) {
      setError(String(e))
    }
  }, [projectId])

  useEffect(() => {
    boxRef.current?.focus()
    void load()
  }, [load])

  return createPortal(
    <div className="confirm-overlay" onClick={onClose}>
      <div
        ref={boxRef}
        className="confirm trust-view"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && isTop()) {
            e.preventDefault()
            onClose()
          }
        }}
        style={{ minWidth: 560, maxWidth: 720 }}
      >
        <h3 style={{ marginBottom: 4 }}>信任关系（只读）</h3>
        <p style={{ fontSize: 13, color: 'var(--sub, #5a6272)', marginBottom: 12 }}>
          各幸存 agent 节点本轮的投递可达性。只读诊断——这里不做任何授权动作。
        </p>
        {error && <p style={{ color: 'var(--bad, #a33a2a)' }}>读取失败：{error}</p>}
        {!error && snap && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--line, #dde1e8)' }}>节点</th>
                <th style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--line, #dde1e8)' }}>状态</th>
                <th style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--line, #dde1e8)' }}>说明</th>
              </tr>
            </thead>
            <tbody>
              {snap.rows.length === 0 && (
                <tr>
                  <td colSpan={3} style={{ padding: '8px' }}>
                    本项目没有 agent 节点。
                  </td>
                </tr>
              )}
              {snap.rows.map((r) => (
                <tr key={r.nodeId}>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--line, #dde1e8)' }}>
                    {r.title}
                    <div style={{ fontSize: 11, color: 'var(--sub, #5a6272)' }}>{r.nodeId}</div>
                  </td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--line, #dde1e8)' }}>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: r.reason === 'proven' ? 'var(--good, #1a7a3d)' : 'var(--warn, #8a6d1a)'
                      }}
                    >
                      {REASON_BADGE[r.reason]}
                    </span>
                    {!r.live && r.reason !== 'session-gone' ? ' · 会话不在' : ''}
                  </td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--line, #dde1e8)' }}>
                    {REASON_TEXT[r.reason]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14 }}>
          <button className="confirm__btn" onClick={() => void load()}>
            刷新
          </button>
          <button className="confirm__btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

