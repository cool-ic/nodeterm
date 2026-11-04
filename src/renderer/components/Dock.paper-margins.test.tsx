// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { Dock } from './Dock'
import { useSettings } from '../state/settings'
import { DEFAULT_SETTINGS } from '@shared/types'
vi.mock('../terminal/use-core-platform', () => ({ useCoreIsWindows: () => false }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('toggles live from the dock, persists, and restores the selection on hydration', async () => {
 vi.useFakeTimers()
 const previous=useSettings.getState(), bridge=window.nodeTerminal
 const save=vi.fn(async(_settings: unknown)=>{}), load=vi.fn(async()=>({...DEFAULT_SETTINGS,terminalPaperMargins:true}))
 ;(window as any).nodeTerminal={settings:{save,load}}
 useSettings.setState({settings:{...DEFAULT_SETTINGS,terminalPaperMargins:false},hydrated:true})
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 const props={group:'compact',zoomPct:100,canvasLocked:false} as ComponentProps<typeof Dock>
 const button=()=>host.querySelector<HTMLButtonElement>('button[aria-label="Paper margins"]')!
 try{
  await act(async()=>root.render(<Dock {...props}/>))
  expect(button().getAttribute('aria-pressed')).toBe('false')
  await act(async()=>button().click())
  expect(button().getAttribute('aria-pressed')).toBe('true')
  await act(async()=>vi.advanceTimersByTime(300))
  expect(save.mock.calls.at(-1)?.[0]).toMatchObject({terminalPaperMargins:true})
  await act(async()=>useSettings.setState({settings:{...DEFAULT_SETTINGS},hydrated:false}))
  await act(async()=>useSettings.getState().hydrate())
  expect(button().getAttribute('aria-pressed')).toBe('true')
  await act(async()=>button().click())
  expect(button().getAttribute('aria-pressed')).toBe('false')
  await act(async()=>useSettings.getState().flush())
  expect(save.mock.calls.at(-1)?.[0]).toMatchObject({terminalPaperMargins:false})
 }finally{
  await act(async()=>root.unmount());host.remove();useSettings.setState(previous);(window as any).nodeTerminal=bridge;vi.useRealTimers()
 }
})
