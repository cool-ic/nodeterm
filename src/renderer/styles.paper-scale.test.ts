import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { generate, parse, walk } from 'css-tree'

it('material layers inherit their owner’s scale instead of resetting it on the child', () => {
  // The Markdown node owns the inline scale; terminal-paper is on its CHILD. A local custom
  // property wins over inheritance regardless of selector specificity. This was invisible to
  // setting/IPC tests: 15→30 changed layout padding but rendered text stayed at a 15px font size.
  const ast = parse(readFileSync(join(__dirname, 'styles.css'), 'utf8'))
  const resets: string[] = []
  walk(ast, { visit: 'Rule', enter(rule) {
    if (!rule.prelude || !generate(rule.prelude).includes('.terminal-paper')) return
    walk(rule.block, { visit: 'Declaration', enter(declaration) {
      if (['--paper-font-size', '--paper-tile-size'].includes(declaration.property)) resets.push(declaration.property)
    } })
  } })
  expect(resets).toEqual([])
})
