import { describe, expect, it } from 'vitest'
import { hookEvents, levelKey, normLevels, objKey, pickNew } from '../src/plugins/currentrms.js'

describe('Current RMS: what to sync', () => {
  it('nothing is created by itself by default, messages are mirrored', () => {
    const l = normLevels(undefined)
    expect(Object.keys(l)).toContain('Opportunity')
    expect(l.Opportunity).toEqual({ objects: false, discussions: false, messages: true })
    expect(normLevels({ Product: { objects: true, messages: false } }).Product).toEqual({ objects: true, discussions: false, messages: false })
  })

  it('registers only the webhooks the levels need', () => {
    const none = normLevels(Object.fromEntries(['Opportunity', 'Project', 'Product', 'Service', 'Member', 'Invoice', 'Activity', 'Quarantine', 'PurchaseOrder'].map((t) => [t, { messages: false }])))
    expect(hookEvents(none)).toEqual([])
    const l = normLevels({ ...none, Opportunity: { objects: true, discussions: true, messages: false }, Product: { objects: true, messages: false }, Service: { objects: true, messages: false } })
    expect(hookEvents(l)).toEqual(['item_create', 'opportunity_create', 'opportunity_discuss'])
    expect(hookEvents(normLevels({}))).toEqual(['discussion_comment'])
  })

  it('takes only records created after the level was switched on, not seen yet, oldest first', () => {
    const since = Date.parse('2026-11-20T12:00:00Z')
    const list = [
      { id: '7', createdAt: Date.parse('2026-11-20T12:05:00Z') },
      { id: '3', createdAt: Date.parse('2026-11-19T10:00:00Z') }, // before: never
      { id: '9', createdAt: Date.parse('2026-11-20T12:01:00Z') },
      { id: '8', createdAt: Date.parse('2026-11-20T12:03:00Z') }, // already handled
    ]
    expect(pickNew(list, since, new Set(['8']), 10).map((x) => x.id)).toEqual(['9', '7'])
    expect(pickNew(list, since, new Set(), 1).map((x) => x.id)).toEqual(['9'])
  })

  it('products of discussions ("Item") share the product record', () => {
    expect(levelKey('Item')).toBe('Product')
    expect(objKey('Item', 5)).toBe('Product:5')
    expect(objKey('Opportunity', '12')).toBe('Opportunity:12')
  })
})
