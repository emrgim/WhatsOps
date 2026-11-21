import { describe, expect, it } from 'vitest'
import { uvAsset, WhisperInstaller } from '../src/whisper-install.js'

describe('faster-whisper install button', () => {
  it('the right download for each WhatsOps build', () => {
    expect(uvAsset('linux', 'x64')).toBe('uv-x86_64-unknown-linux-gnu.tar.gz')
    expect(uvAsset('linux', 'arm64')).toBe('uv-aarch64-unknown-linux-gnu.tar.gz')
    expect(uvAsset('darwin', 'arm64')).toBe('uv-aarch64-apple-darwin.tar.gz')
    expect(uvAsset('darwin', 'x64')).toBe('uv-x86_64-apple-darwin.tar.gz')
    expect(uvAsset('win32', 'x64')).toBe('uv-x86_64-pc-windows-msvc.zip')
    // no ready-made faster-whisper package there
    expect(uvAsset('win32', 'arm64')).toBeNull()
    expect(uvAsset('linux', 'ia32')).toBeNull()
  })
  it('a system without packages says so, nothing is downloaded', async () => {
    const inst = new WhisperInstaller('/nonexistent/whisper', 'win32', 'arm64')
    expect(inst.supported).toBe(false)
    expect(inst.python()).toBeNull()
    await expect(inst.install()).rejects.toMatchObject({ code: 'STT_INSTALL_PLATFORM' })
    expect(inst.st.state).toBe('idle')
  })
  it('its own Python lives in WhatsOps\' folder', () => {
    expect(new WhisperInstaller('/d/whisper', 'linux', 'x64').python()).toBeNull()
  })
})
