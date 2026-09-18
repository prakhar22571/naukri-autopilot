import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
