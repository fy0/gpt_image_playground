import { describe, expect, it } from 'vitest'
import { getEmbedLeftOffset, normalizeEmbedLeftOffset } from './embedLayout'

describe('embed layout params', () => {
  it('reads embedLeft as pixel offset', () => {
    expect(getEmbedLeftOffset(new URLSearchParams('embedLeft=88'))).toBe(88)
  })

  it('supports px suffix', () => {
    expect(normalizeEmbedLeftOffset('120px')).toBe(120)
  })

  it('clamps large offsets', () => {
    expect(normalizeEmbedLeftOffset('999')).toBe(320)
  })

  it('ignores invalid offsets', () => {
    expect(normalizeEmbedLeftOffset(null)).toBe(0)
    expect(normalizeEmbedLeftOffset('')).toBe(0)
    expect(normalizeEmbedLeftOffset('-20')).toBe(0)
    expect(normalizeEmbedLeftOffset('20rem')).toBe(0)
  })
})
