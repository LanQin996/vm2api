import { describe, expect, it } from 'vitest'
import {
  cacheTtlFromCompat,
  DEFAULT_CACHE_TTL,
  normalizeCacheTtl,
} from './cache-breakpoints'

describe('cache TTL setting', () => {
  it('shows auto when no TTL was configured', () => {
    expect(DEFAULT_CACHE_TTL).toBe('auto')
    expect(cacheTtlFromCompat({})).toBe('auto')
    expect(cacheTtlFromCompat({ cache_ttl: 'auto' })).toBe('auto')
  })

  it('preserves a saved 1h or 5m selection', () => {
    expect(cacheTtlFromCompat({ cache_ttl: '1h' })).toBe('1h')
    expect(cacheTtlFromCompat({ cache_ttl: '5m' })).toBe('5m')
    expect(normalizeCacheTtl('unknown')).toBe('auto')
  })
})
