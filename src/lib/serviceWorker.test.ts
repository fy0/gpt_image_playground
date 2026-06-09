import { describe, expect, it } from 'vitest'
import source from '../../public/sw.js?raw'

describe('service worker fetch handling', () => {
  it('bypasses backend API requests instead of caching task status responses', () => {
    expect(source).toContain("'/backend-api/'")
    expect(source).toContain("'/api-proxy/'")
    expect(source).toContain('isApiRequest(url)')
    expect(source).toContain("request.cache === 'no-store'")
  })
})
