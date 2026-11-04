import { Suspense, lazy } from 'react'
import type { NodeProps } from '@xyflow/react'
import type { CanvasNode } from '../state/workspace'
import { isMarkdownExt } from '../lib/markdownPreview'

// EditorNode/DiffNode pull in the whole of monaco-editor (several MB of JS). Importing them
// statically put Monaco in the startup chunk for every launch — including the common canvas
// of terminals with no editor node at all. These wrappers are what goes into `nodeTypes`;
// Monaco's chunk is fetched the first time an editor/diff node actually mounts.
const EditorInner = lazy(() => import('./EditorNode').then((m) => ({ default: m.EditorNode })))
const DiffInner = lazy(() => import('./DiffNode').then((m) => ({ default: m.DiffNode })))
const MarkdownInner = lazy(() => import('./PaperMarkdownNode').then((m) => ({ default: m.PaperMarkdownNode })))

function LoadingBody() {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#1e1e1e',
        borderRadius: 10,
        color: 'rgba(255,255,255,0.4)',
        fontSize: 12
      }}
    >
      Loading editor…
    </div>
  )
}

export function LazyEditorNode(props: NodeProps<CanvasNode>) {
  const ext = String(props.data.filePath ?? '').split('.').pop() ?? ''
  return (
    <Suspense fallback={<LoadingBody />}>
      {isMarkdownExt(ext) ? <MarkdownInner key={String(props.data.filePath)} {...props} /> : <EditorInner {...props} />}
    </Suspense>
  )
}

export function LazyDiffNode(props: NodeProps<CanvasNode>) {
  return (
    <Suspense fallback={<LoadingBody />}>
      <DiffInner {...props} />
    </Suspense>
  )
}
