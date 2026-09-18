import { safeStorage } from 'electron'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AuthState } from '../shared/protocol'

export class SessionVault {
  private path: string
  constructor(directory: string) {
    this.path = join(directory, 'login.session')
  }
  exists(): boolean {
    return existsSync(this.path)
  }
  read(): AuthState | null {
    if (!this.exists()) return null
    if (!safeStorage.isEncryptionAvailable())
      throw new Error(
        'Windows session encryption is unavailable. Reconnect after signing into Windows.',
      )
    try {
      return JSON.parse(safeStorage.decryptString(readFileSync(this.path)))
    } catch {
      throw new Error('The saved session could not be decrypted. Reconnect to Naukri.')
    }
  }
  write(state: AuthState): void {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('Windows session encryption is unavailable. Session was not saved.')
    const pending = `${this.path}.tmp`
    writeFileSync(pending, safeStorage.encryptString(JSON.stringify(state)), { mode: 0o600 })
    renameSync(pending, this.path)
  }
  clear(): void {
    if (this.exists()) unlinkSync(this.path)
  }
}
