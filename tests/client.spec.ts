import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

describe('sidebar client bundle', () => {
  it('registers a Chinese right-sidebar tab and body', async () => {
    const code = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
    let factory: ((require: (name: string) => unknown) => Record<string, unknown>) | undefined
    const style = { dataset: {} as Record<string, string>, textContent: '', remove: () => {} }
    const context = {
      window: {
        __ModuleLoader__: { load: (value: { factory: typeof factory }) => { factory = value.factory } },
        location: { origin: 'http://localhost' },
        alert: () => {},
        confirm: () => false,
        prompt: () => null
      },
      document: {
        createElement: () => style,
        head: { appendChild: () => {} }
      },
      URL,
      console,
      fetch: async () => ({ ok: true, json: async () => ({}) })
    }
    vm.runInNewContext(code, context)
    expect(factory).toBeTypeOf('function')

    const registrations: Array<Record<string, unknown>> = []
    const scope = {
      effect: (fn: () => unknown) => { fn(); return () => {} },
      sidebarRightTabs: {
        register: (definition: Record<string, unknown>) => {
          registrations.push(definition)
          return () => {}
        }
      },
      slots: {
        inject: (_name: string, fn: () => void) => { fn(); return () => {} },
        register: (value: Record<string, unknown>) => {
          registrations.push(value)
          return () => {}
        }
      },
      inject: () => {}
    }
    const React = { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {} }
    const mod = factory!((name) => {
      if (name === 'react') return React
      throw new Error(name)
    })
    expect(mod.inject).toEqual(['slots', 'sidebarRightTabs'])
    ;(mod.apply as (ctx: unknown) => void)(scope)

    const definition = registrations.find((item) => item.kind === 'memory')
    expect(definition).toMatchObject({ id: '@ascrm88/dsh-memory', title: expect.any(Function) })
    expect(registrations).toContainEqual(expect.objectContaining({
      name: 'sidebar.right.pane.tab',
      key: '@ascrm88/dsh-memory'
    }))
  })
})
