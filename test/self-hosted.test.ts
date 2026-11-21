import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JS packaging script
import { findHostedAddresses } from '../packaging/check-self-hosted.mjs'

describe('self-hosted', () => {
  it('no address of a real installation in the code, pages, installers or docs', () => {
    expect(findHostedAddresses(path.resolve(__dirname, '..'))).toEqual([])
  })
})
