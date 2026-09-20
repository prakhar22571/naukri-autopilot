import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/main/database'
import { defaultSettings } from '../../src/shared/settings'

test('desktop navigation, editable preferences, validation and persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autopilot-desktop-'))
  const launch = () =>
    electron.launch({
      args: ['.'],
      env: { ...process.env, AUTOPILOT_TEST: '1', AUTOPILOT_TEST_DATA: directory },
      timeout: 30_000,
    })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await expect(page.getByRole('heading', { name: 'Make your next move.' })).toBeVisible()
    await expect(page.getByText('0 of 3 essentials ready')).toBeVisible()
    expect(
      await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require),
    ).toBe('undefined')
    const encryption = await app.evaluate(({ safeStorage }) => {
      const protectedData = safeStorage.encryptString('fixture-session-token')
      return {
        plaintextPresent: protectedData.includes(Buffer.from('fixture-session-token')),
        restored: safeStorage.decryptString(protectedData),
      }
    })
    expect(encryption).toEqual({ plaintextPresent: false, restored: 'fixture-session-token' })
    await page.screenshot({ path: 'test-results/dashboard.png', fullPage: true })
    await page.getByRole('navigation').getByRole('button', { name: 'Jobs' }).click()
    await expect(
      page.getByRole('heading', { name: 'Your next opportunity is out there' }),
    ).toBeVisible()
    await page.getByRole('navigation').getByRole('button', { name: 'Settings' }).click()
    await page
      .getByLabel('Target roles', { exact: false })
      .pressSequentially('Frontend Developer, React Developer')
    await page.getByLabel('Required skills', { exact: false }).fill('React, TypeScript')
    await page.getByLabel('Daily application limit', { exact: false }).fill('25')
    await page.getByRole('button', { name: 'Save all settings' }).click()
    await expect(page.getByText('Settings saved on this computer.')).toBeVisible()
    await expect(page.getByText('You have unsaved changes.')).toHaveCount(0)
    await page.getByRole('navigation').getByRole('button', { name: 'Profile' }).click()
    await expect(page.getByRole('heading', { name: 'Your resume', exact: true })).toBeVisible()
    await page.getByRole('navigation').getByRole('button', { name: 'Runs' }).click()
    await expect(page.getByRole('heading', { name: 'Your story starts here' })).toBeVisible()
    await page.getByRole('navigation').getByRole('button', { name: 'Overview' }).click()
    await page.getByRole('button', { name: 'Start autopilot' }).click()
    await expect(page.getByRole('alert')).toContainText('Connect your Naukri account')
    expect(errors).toEqual([])
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await page.getByRole('navigation').getByRole('button', { name: 'Settings' }).click()
    await expect(page.getByLabel('Target roles', { exact: false })).toHaveValue(
      'Frontend Developer, React Developer',
    )
    await expect(page.getByLabel('Daily application limit', { exact: false })).toHaveValue('25')
    await page.screenshot({ path: 'test-results/settings.png', fullPage: true })
  } finally {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('scheduled waiting, pause with a draft, and blocked connection recovery are visible', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autopilot-recovery-'))
  const launch = () => electron.launch({ args: ['.'], env: { ...process.env, AUTOPILOT_TEST: '1', AUTOPILOT_TEST_DATA: directory } })
  let app = await launch()
  try {
    const encrypted = await app.evaluate(({ safeStorage }) => safeStorage.encryptString(JSON.stringify({ cookies: [], origins: [] })).toString('base64'))
    await app.close()
    await writeFile(join(directory, 'login.session'), Buffer.from(encrypted, 'base64'))
    const resumePath = join(directory, 'resumes', 'fixture.pdf')
    await writeFile(resumePath, '%PDF fixture')
    const store = new Store(directory)
    store.set('resume', { name: 'fixture.pdf', path: resumePath, sha256: 'fixture', importedAt: new Date().toISOString() })
    store.set('settings', { ...defaultSettings, active: true, filters: { ...defaultSettings.filters, titles: ['Developer'] } })
    store.close()
    app = await launch()
    let page = await app.firstWindow()
    await expect(page.getByText(/Waiting for the next schedule/)).toBeVisible()
    await page.getByRole('navigation').getByRole('button', { name: 'Settings' }).click()
    await page.getByLabel('Target roles', { exact: false }).fill('New draft role')
    await page.getByRole('button', { name: 'Pause autopilot' }).click()
    await expect(page.getByRole('button', { name: 'Start autopilot', exact: true })).toBeVisible()
    await expect(page.getByLabel('Target roles', { exact: false })).toHaveValue('New draft role')
    await expect(page.getByText('You have unsaved changes.')).toBeVisible()
    const snapshot = await page.evaluate(() => window.autopilot.snapshot())
    expect(snapshot.settings.active).toBe(false)
    expect(snapshot.settings.filters.titles).toEqual(['Developer'])
    await app.close()

    const blocked = new Store(directory)
    blocked.set('connection', { status: 'blocked', message: 'Naukri blocked this browser. Your saved login is retained.' })
    const run = blocked.createRun('applications', 'manual')
    blocked.saveRun({ ...run, status: 'attention', message: 'Access denied before any applications were submitted.', finishedAt: new Date().toISOString() })
    blocked.close()
    app = await launch()
    page = await app.firstWindow()
    await expect(page.getByRole('alert')).toContainText('Your saved login is retained')
    await expect(page.getByRole('button', { name: 'Check connection', exact: true })).toBeVisible()
    await expect(page.getByText('Job applications: Access denied before any applications were submitted.')).toBeVisible()
    await page.getByRole('button', { name: 'View run details', exact: true }).click()
    await expect(page.getByText('Access denied before any applications were submitted.', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('navigation').getByRole('button', { name: 'Profile' }).click()
    await expect(page.getByText('Access blocked', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible()
    await page.screenshot({ path: 'test-results/connection-recovery.png', fullPage: true })
  } finally {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  }
})
