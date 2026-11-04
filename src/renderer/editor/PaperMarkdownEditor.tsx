import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, drawSelection, highlightSpecialChars } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { markdownInk } from './markdown-ink'
import { BUNDLED_TERMINAL_FONT, loadTerminalFonts } from '../terminal/paper-fonts'

const inkSyntax = HighlightStyle.define([
  { tag: tags.heading, class: 'paper-md-heading' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], class: 'paper-md-link' },
  { tag: [tags.monospace, tags.processingInstruction], class: 'paper-md-code' },
  { tag: [tags.meta, tags.quote], class: 'paper-md-marker' }
])

interface Props {
  initialText: string
  fileName: string
  onChange: (text: string) => void
  onSave: () => void
  onReady?: (view: EditorView | null) => void
}

/** Mount once per file; reading mode hides this view instead of losing selection/undo/IME state. */
export function PaperMarkdownEditor({ initialText, fileName, onChange, onSave, onReady }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onChange, onSave, onReady })
  callbacks.current = { onChange, onSave, onReady }
  useEffect(() => {
    let disposed = false
    let view: EditorView | undefined
    void loadTerminalFonts(BUNDLED_TERMINAL_FONT).then(() => {
      if (disposed || !host.current) return
      view = new EditorView({
        parent: host.current,
        state: EditorState.create({
          doc: initialText,
          extensions: [
            EditorState.lineSeparator.of(initialText.match(/\r\n|\r|\n/)?.[0] ?? '\n'),
            history(), drawSelection(), highlightSpecialChars(), EditorView.lineWrapping,
            markdown({ base: markdownLanguage }), syntaxHighlighting(inkSyntax), markdownInk(),
            EditorView.contentAttributes.of({ 'aria-label': `Edit ${fileName}`, spellcheck: 'false' }),
            keymap.of([
              { key: 'Mod-s', run: () => { callbacks.current.onSave(); return true }, stopPropagation: true },
              ...defaultKeymap, ...historyKeymap
            ]),
            EditorView.updateListener.of(update => {
              if (update.docChanged) callbacks.current.onChange(update.state.sliceDoc())
            })
          ]
        })
      })
      callbacks.current.onReady?.(view)
    })
    return () => { disposed = true; callbacks.current.onReady?.(null); view?.destroy() }
    // Node is keyed by file path; live settings are CSS variables and don't rebuild this view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <div ref={host} className="paper-markdown__source nodrag nowheel nokey" />
}
