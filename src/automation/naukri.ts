import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Locator,
} from 'playwright-core'
import type { AuthState } from '../shared/protocol'
import type {
  CandidateFacts,
  Job,
  JobFilters,
  SavedAnswer,
  ScreeningQuestion,
  StepResult,
} from '../shared/types'
import {
  parseExperience,
  parsePostingDate,
  parseSalary,
  jobIdFromUrl,
  isNaukriUrl,
} from './parsing'
import { resolveAnswer } from '../core/answers'
import { normalize } from '../core/matching'
import { basename } from 'node:path'

export class AttentionError extends Error {}
export class StructureError extends Error {}
export class SubmissionNotStartedError extends StructureError {}
export class StoppedError extends Error {}
export interface SubmissionResult {
  status: 'applied' | 'unknown' | 'not_submitted'
  reason: string
  question?: ScreeningQuestion
  externalUrl?: string
}
const PROFILE = 'https://www.naukri.com/mnjuser/profile'

export class NaukriAdapter {
  browser: Browser | null = null
  context: BrowserContext | null = null
  page: Page | null = null
  private externalNavigation: string | null = null
  private protectNavigation = false
  constructor(
    private readonly stopped: () => boolean,
    private readonly progress: (text: string) => void,
  ) {}
  checkStop(): void {
    if (this.stopped()) throw new StoppedError('Stopped by you.')
  }
  async open(auth: AuthState | null, background: boolean): Promise<void> {
    try {
      this.browser = await chromium.launch({
        channel: 'chrome',
        headless: background,
        chromiumSandbox: true,
      })
    } catch {
      throw new Error('Chrome could not start. Install Google Chrome, then try again.')
    }
    this.context = await this.browser.newContext({
      storageState: auth ?? undefined,
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: false,
    })
    this.context.setDefaultTimeout(12_000)
    this.context.setDefaultNavigationTimeout(30_000)
    await this.context.route('**/*', async (route) => {
      const request = route.request()
      if (
        this.protectNavigation &&
        request.isNavigationRequest() &&
        !request.frame().parentFrame() &&
        !isNaukriUrl(request.url())
      ) {
        this.externalNavigation = request.url()
        await route.abort()
        return
      }
      await route.continue()
    })
    this.page = await this.context.newPage()
  }
  async navigate(url: string): Promise<void> {
    this.checkStop()
    if (!isNaukriUrl(url)) throw new StructureError('The job link does not point to Naukri.')
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.page!.goto(url, { waitUntil: 'domcontentloaded' })
        return
      } catch (error) {
        this.checkStop()
        if (attempt === 2 || this.page!.isClosed()) throw error
        await this.page!.waitForTimeout(1000 * (attempt + 1))
      }
    }
  }
  private async visible(locator: Locator): Promise<boolean> {
    return locator
      .first()
      .isVisible()
      .catch(() => false)
  }
  async assertReady(): Promise<void> {
    if (!this.page || this.page.isClosed()) throw new Error('The browser window was closed.')
    if (await this.visible(this.page.locator('input[type="password"]')))
      throw new AttentionError('Your Naukri session expired. Reconnect to continue.')
    const body = await this.page.locator('body').innerText({ timeout: 10_000 })
    if (
      /access denied|verify (?:that )?you are human|unusual (?:traffic|activity)|temporarily blocked|too many requests/i.test(
        body,
      ) ||
      (await this.visible(this.page.locator('iframe[src*="captcha"]')))
    )
      throw new AttentionError(
        'Naukri needs your attention. Reconnect in the visible browser to resolve the challenge.',
      )
    if (/\/nlogin|\/login(?:[/?#]|$)/i.test(this.page.url()))
      throw new AttentionError('Your Naukri session expired. Reconnect to continue.')
  }
  async isSignedIn(): Promise<boolean> {
    if (!this.page || this.page.isClosed()) return false
    if (await this.visible(this.page.locator('input[type="password"]'))) return false
    return (
      (await this.visible(
        this.page.locator(
          'a[href*="/mnjuser/profile"], .nI-gNb-drawer__icon, .nI-gNb-drawer__bars',
        ),
      )) ||
      (this.page.url().includes('/mnjuser/profile') &&
        (await this.visible(this.page.getByText('Resume headline', { exact: true }))))
    )
  }
  async login(): Promise<AuthState> {
    await this.navigate('https://www.naukri.com/nlogin/login')
    this.progress('Log in to Naukri in Chrome. Your password stays in the browser.')
    const deadline = Date.now() + 10 * 60_000
    while (Date.now() < deadline) {
      this.checkStop()
      if (this.page!.isClosed())
        throw new StoppedError('Login window closed. You can reconnect whenever you are ready.')
      if (await this.isSignedIn()) {
        await this.navigate(PROFILE)
        await this.page!.getByText('Resume headline', { exact: true })
          .first()
          .waitFor({ timeout: 20_000 })
        await this.assertReady()
        return await this.state()
      }
      await this.page!.waitForTimeout(750)
    }
    throw new AttentionError('Login timed out. Reconnect when you are ready.')
  }
  async verifySession(): Promise<void> {
    await this.navigate(PROFILE)
    await this.page!.locator('body').waitFor()
    await this.page!.getByText('Resume headline', { exact: true })
      .first()
      .waitFor({ timeout: 20_000 })
      .catch(() => undefined)
    await this.assertReady()
    if (!(await this.isSignedIn()))
      throw new AttentionError('Could not verify your Naukri session. Reconnect to continue.')
    this.protectNavigation = true
  }
  async state(): Promise<AuthState> {
    return this.context!.storageState({ indexedDB: true })
  }
  async uploadResume(path: string): Promise<StepResult> {
    this.checkStop()
    await this.navigate(PROFILE)
    await this.assertReady()
    const input = this.page!.locator(
      'input[type="file"][id*="attach"], input[type="file"][accept*="pdf"], input[type="file"][name*="resume"], input#attachCV',
    ).first()
    if (!(await input.count()))
      throw new StructureError(
        'Could not locate the resume upload control. No upload was attempted.',
      )
    await input.setInputFiles(path)
    const feedback = this.page!.getByText(
      /resume (?:has been )?(?:uploaded|updated) successfully|successfully (?:uploaded|updated)/i,
    ).first()
    try {
      await feedback.waitFor({ state: 'visible', timeout: 25_000 })
    } catch {
      return {
        name: 'Resume upload',
        status: 'unknown',
        message:
          'Upload was attempted, but Naukri did not show a success confirmation. Check your profile.',
      }
    }
    await this.navigate(PROFILE)
    await this.assertReady()
    const filename = this.page!.getByText(basename(path), { exact: false }).first()
    if (!(await this.visible(filename)))
      return {
        name: 'Resume upload',
        status: 'unknown',
        message: 'Naukri acknowledged the upload, but the saved filename could not be verified.',
      }
    return {
      name: 'Resume upload',
      status: 'succeeded',
      message: `${basename(path)} uploaded and verified.`,
    }
  }
  async rotateHeadline(
    headlines: string[],
    index: number,
  ): Promise<{ step: StepResult; nextIndex: number }> {
    this.checkStop()
    const section = this.page!.locator(
      '#lazyResumeHead, .resumeHeadline, [data-section="resumeHeadline"]',
    ).first()
    if (!(await section.count()))
      throw new StructureError(
        'Could not locate the resume headline section. No headline was changed.',
      )
    const headlineText = section
      .locator('.prefill, .resumeHeadlineText, [data-current-headline], #headline')
      .first()
    const current = (await headlineText.count())
      ? await headlineText.innerText()
      : (await section.innerText())
          .split('\n')
          .filter((line) => !/^(?:resume headline|edit|editOne)$/i.test(line.trim()))
          .join(' ')
          .trim()
    const choices = headlines.map((_, offset) => (index + offset) % headlines.length)
    const selected = choices.find((i) => normalize(current) !== normalize(headlines[i]))
    if (selected === undefined)
      return {
        step: {
          name: 'Headline',
          status: 'skipped',
          message: 'The available headline text is already present.',
        },
        nextIndex: index,
      }
    const edit = section
      .getByText(/^(?:edit|editOne)$/i)
      .or(section.locator('[class*="edit"]'))
      .first()
    if (!(await this.visible(edit)))
      throw new StructureError('Could not locate the headline edit button.')
    await edit.click()
    const textarea = this.page!.locator(
      'textarea#resumeHeadlineTxt, textarea[name="resumeHeadline"], [role="dialog"] textarea',
    ).first()
    await textarea.waitFor({ state: 'visible' })
    await textarea.fill(headlines[selected])
    this.checkStop()
    await this.page!.getByRole('button', { name: /^save$/i }).click()
    await textarea.waitFor({ state: 'hidden', timeout: 15_000 })
    await this.navigate(PROFILE)
    await this.assertReady()
    if (!(await this.visible(this.page!.getByText(headlines[selected], { exact: true }))))
      return {
        step: {
          name: 'Headline',
          status: 'unknown',
          message: 'Saved headline could not be verified. Rotation position was preserved.',
        },
        nextIndex: index,
      }
    return {
      step: { name: 'Headline', status: 'succeeded', message: 'Headline saved and verified.' },
      nextIndex: (selected + 1) % headlines.length,
    }
  }
  async discover(filters: JobFilters, maximum = 100): Promise<string[]> {
    const urls = new Map<string, string>()
    for (const title of filters.titles) {
      this.checkStop()
      const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
      if (!slug) continue
      for (let pageNumber = 1; pageNumber <= 5 && urls.size < maximum; pageNumber++) {
        const search = new URL(
          `https://www.naukri.com/${slug}-jobs${pageNumber === 1 ? '' : `-${pageNumber}`}`,
        )
        search.searchParams.set('k', title)
        if (filters.locations.length) search.searchParams.set('l', filters.locations.join(', '))
        this.progress(`Finding ${title} roles · page ${pageNumber}`)
        await this.navigate(search.toString())
        await this.assertReady()
        await this.page!.locator('a[href*="job-listings-"]')
          .first()
          .waitFor({ timeout: 15_000 })
          .catch(() => undefined)
        const links = await this.page!.locator('a[href*="job-listings-"]').evaluateAll((elements) =>
          elements.map((e) => (e as HTMLAnchorElement).href),
        )
        if (!links.length) {
          if (
            await this.visible(
              this.page!.getByText(/no (?:jobs|results|matching jobs) found|couldn.t find any/i),
            )
          )
            break
          throw new StructureError(
            'The job results could not be read. The run stopped without guessing at the page structure.',
          )
        }
        const before = urls.size
        for (const link of links) {
          const id = jobIdFromUrl(link)
          if (id && urls.size < maximum) {
            const url = new URL(link)
            url.search = ''
            url.hash = ''
            urls.set(id, url.toString())
          }
        }
        if (urls.size === before) break
      }
      if (urls.size >= maximum) break
    }
    return [...urls.values()]
  }
  async inspect(url: string): Promise<Job> {
    await this.navigate(url)
    await this.assertReady()
    const id = jobIdFromUrl(url)
    if (!id) throw new StructureError('Could not identify this Naukri job.')
    const closed = await this.visible(
      this.page!.getByText(
        /this job (?:has expired|is no longer available)|job (?:has been closed|not found)/i,
      ),
    )
    if (!closed) await this.page!.locator('h1').first().waitFor({ timeout: 15_000 })
    const raw = await this.page!.evaluate(() => {
      const text = (...selectors: string[]) => {
        for (const selector of selectors) {
          const el = document.querySelector<HTMLElement>(selector)
          if (el?.innerText.trim()) return el.innerText.trim()
        }
        return ''
      }
      let structured: Record<string, any> | null = null
      const visit = (value: any): void => {
        if (!value || typeof value !== 'object') return
        if (Array.isArray(value)) {
          value.forEach(visit)
          return
        }
        if (
          value['@type'] === 'JobPosting' ||
          (Array.isArray(value['@type']) && value['@type'].includes('JobPosting'))
        )
          structured = value
        if (value['@graph']) visit(value['@graph'])
      }
      for (const element of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          visit(JSON.parse(element.textContent ?? ''))
        } catch {}
      }
      return {
        title: text('h1'),
        company: text(
          '[class*="jd-header-comp-name"] a',
          '.jd-header-comp-name a',
          '[itemprop="hiringOrganization"]',
          '.company-name',
        ),
        description: text(
          '[class*="dang-inner-html"]',
          '.job-desc',
          '.job-description',
          '[itemprop="description"]',
        ),
        experience: text('[class*="exp-wrap"]', '.exp', '[class*="jhc__exp"]'),
        salary: text('[class*="salary-wrap"]', '.salary', '[class*="jhc__salary"]'),
        location: text('[class*="loc-wrap"]', '.loc', '[class*="jhc__location"]'),
        date: text('[class*="job-post-day"]', '.posting-date', '[class*="jd-stats"]'),
        skills: Array.from(
          document.querySelectorAll<HTMLElement>(
            '[class*="key-skill"] a, .key-skill a, [class*="chip"] span',
          ),
        )
          .map((e) => e.innerText.trim())
          .filter(Boolean),
        body: document.body.innerText,
        structured,
      }
    })
    const structured = raw.structured as Record<string, any> | null
    const exp = parseExperience(
      raw.experience ||
        raw.body.match(
          /(?:experience[:\s]*)?\d+(?:\.\d+)?\s*(?:-|–|to)\s*\d+(?:\.\d+)?\s*(?:years?|yrs?)/i,
        )?.[0] ||
        '',
    )
    let salary = parseSalary(raw.salary)
    if (
      structured?.baseSalary?.currency === 'INR' &&
      structured.baseSalary.value?.unitText === 'YEAR'
    ) {
      const value = structured.baseSalary.value
      const min = Number(value.minValue ?? value.value),
        max = Number(value.maxValue ?? value.value)
      if (Number.isFinite(min) && Number.isFinite(max))
        salary = { min: min / 100000, max: max / 100000 }
    }
    const description =
      raw.description ||
      (typeof structured?.description === 'string'
        ? structured.description.replace(/<[^>]*>/g, ' ')
        : '')
    const locations = Array.isArray(structured?.jobLocation)
      ? structured.jobLocation
      : structured?.jobLocation
        ? [structured.jobLocation]
        : []
    const locationNames = locations
      .map((l: any) => l.address?.addressLocality)
      .filter((l: unknown): l is string => typeof l === 'string')
    const location = raw.location || locationNames.join(', ')
    const mode =
      structured?.jobLocationType === 'TELECOMMUTE' || /\bremote\b|work from home/i.test(location)
        ? 'remote'
        : /\bhybrid\b/i.test(location)
          ? 'hybrid'
          : /work from office|on[- ]site/i.test(location)
            ? 'office'
            : null
    const postedAt =
      parsePostingDate(structured?.datePosted ?? '') ||
      parsePostingDate(raw.date) ||
      parsePostingDate(
        raw.body.match(
          /(?:posted\s*:?\s*)?(?:\d+\s*(?:days?|weeks?|months?|hours?)\s*ago|today|yesterday)/i,
        )?.[0] ?? '',
      )
    if (!closed && ((!raw.title && !structured?.title) || !description))
      throw new StructureError(
        'The job title or description could not be read. The page may have changed.',
      )
    const applied = await this.hasApplied()
    return {
      id,
      url,
      title: raw.title || structured?.title || 'Unavailable job',
      company: raw.company || structured?.hiringOrganization?.name || '',
      description,
      skills: raw.skills,
      locations: location
        .split(/[,;\n]/)
        .map((v) => v.trim())
        .filter(Boolean),
      workMode: mode,
      experienceMin: exp.min,
      experienceMax: exp.max,
      salaryMinLpa: salary.min,
      salaryMaxLpa: salary.max,
      postedAt,
      discoveredAt: new Date().toISOString(),
      status: closed ? 'closed' : applied ? 'applied' : 'matched',
      reasons: closed
        ? ['This job is closed.']
        : applied
          ? ['Naukri shows that you have already applied.']
          : [],
    }
  }
  async hasApplied(): Promise<boolean> {
    return (
      (await this.visible(
        this.page!.getByRole('button', { name: /^(?:applied|application sent)$/i }),
      )) ||
      (await this.visible(
        this.page!.getByText(
          /^(?:you have already applied(?: to this job)?[.!]?|successfully applied(?: to this job)?[.!]?|application (?:has been )?submitted successfully[.!]?)$/i,
        ),
      ))
    )
  }
  async reconcile(url: string): Promise<'applied' | 'unknown'> {
    await this.navigate(url)
    await this.assertReady()
    await this.page!.locator('h1')
      .first()
      .waitFor({ timeout: 12_000 })
      .catch(() => undefined)
    return (await this.hasApplied()) ? 'applied' : 'unknown'
  }
  private async screeningForm(): Promise<{
    fields: { question: ScreeningQuestion; input: Locator }[]
    container: Locator
    unsupported: boolean
  } | null> {
    const containers = this.page!.locator(
      '[role="dialog"], .chatbot-container, [class*="chatbot_Chatbot"], .apply-questionnaire, [data-testid="screening-form"]',
    )
    for (let i = 0; i < (await containers.count()); i++) {
      const container = containers.nth(i)
      if (!(await container.isVisible())) continue
      const inputs = container
        .locator(
          'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select',
        )
        .filter({ visible: true })
      if (!(await inputs.count())) continue
      const fields: { question: ScreeningQuestion; input: Locator }[] = []
      const radioGroups = new Set<string>()
      for (let index = 0; index < (await inputs.count()); index++) {
        const input = inputs.nth(index)
        const metadata = await input.evaluate((el) => {
          const element = el as HTMLInputElement
          const group = element.closest('fieldset, [role="group"], [role="radiogroup"]')
          const label =
            element.type === 'radio'
              ? group?.querySelector('legend')?.textContent ||
                group?.getAttribute('aria-label') ||
                ''
              : element.getAttribute('aria-label') || element.labels?.[0]?.innerText || ''
          return {
            type: element.type,
            tag: element.tagName,
            name: element.name,
            label: label.trim(),
          }
        })
        if (
          ['password', 'checkbox', 'file', 'range', 'date', 'email', 'tel'].includes(metadata.type)
        )
          return { fields, container, unsupported: true }
        if (metadata.type === 'radio') {
          if (!metadata.name) return { fields, container, unsupported: true }
          if (radioGroups.has(metadata.name)) continue
          radioGroups.add(metadata.name)
        }
        let question = metadata.label
        if (!question && (await inputs.count()) === 1)
          question = await container
            .locator('[class*="question"], [data-question], legend')
            .last()
            .innerText()
            .catch(() => '')
        if (!question.trim()) return { fields, container, unsupported: true }
        const qtype =
          metadata.tag === 'SELECT' ? 'select' : metadata.type === 'radio' ? 'radio' : 'text'
        const options =
          qtype === 'select'
            ? await input
                .locator('option')
                .evaluateAll((els) =>
                  els
                    .filter(
                      (e) =>
                        !(e as HTMLOptionElement).disabled && (e as HTMLOptionElement).value !== '',
                    )
                    .map((e) => e.textContent?.trim() || ''),
                )
            : qtype === 'radio'
              ? await container
                  .locator('input[type="radio"]')
                  .evaluateAll(
                    (els, name) =>
                      els
                        .filter((e) => (e as HTMLInputElement).name === name)
                        .map((e) => (e as HTMLInputElement).labels?.[0]?.innerText.trim() || ''),
                    metadata.name,
                  )
              : []
        if (options.some((option) => !option)) return { fields, container, unsupported: true }
        fields.push({ question: { question: question.trim(), type: qtype, options }, input })
      }
      return { fields, container, unsupported: false }
    }
    return null
  }
  async apply(job: Job, answers: SavedAnswer[], facts: CandidateFacts): Promise<SubmissionResult> {
    // Caller has persisted submission intent. No write is retried in this method.
    this.externalNavigation = null
    this.checkStop()
    await this.assertReady()
    const external = this.page!.getByRole('link', {
      name: /^apply(?: on company (?:site|website))?$/i,
    }).first()
    if (await this.visible(external)) {
      const href = await external.getAttribute('href')
      if (href) {
        const url = new URL(href, job.url).toString()
        if (!isNaukriUrl(url))
          return {
            status: 'not_submitted',
            reason: 'Application continues on the employer website.',
            externalUrl: url,
          }
      }
    }
    const apply = this.page!.getByRole('button', { name: /^apply(?: now)?$/i }).first()
    if (!(await this.visible(apply))) {
      if (await this.hasApplied())
        return { status: 'applied', reason: 'Naukri confirms that you have already applied.' }
      if (await this.visible(this.page!.getByText(/apply on company (?:site|website)/i)))
        return { status: 'not_submitted', reason: 'This job requires an external application.' }
      throw new SubmissionNotStartedError(
        'Could not identify the Apply button. No click was attempted.',
      )
    }
    await apply.click({ noWaitAfter: true })
    const deadline = Date.now() + 35_000
    let answered = 0
    const handled = new Set<string>()
    while (Date.now() < deadline && !this.page!.isClosed()) {
      // After a click, observe first even if Stop was pressed.
      if (await this.hasApplied())
        return { status: 'applied', reason: 'Naukri confirmed the application.' }
      if (this.externalNavigation)
        return {
          status: 'not_submitted',
          reason: 'Application redirects to an employer website.',
          externalUrl: this.externalNavigation,
        }
      await this.assertReady()
      const form = await this.screeningForm()
      if (form) {
        if (this.stopped())
          return {
            status: 'not_submitted',
            reason: 'Stopped before completing the required screening questions.',
          }
        if (form.unsupported)
          return {
            status: 'not_submitted',
            reason: 'This screening form needs manual completion on Naukri.',
          }
        for (const field of form.fields) {
          const signature = JSON.stringify(field.question)
          const answer = resolveAnswer(field.question, answers, facts)
          if (answer === null || handled.has(signature) || answered >= 12)
            return {
              status: 'not_submitted',
              reason:
                answer === null
                  ? 'A screening question needs your answer.'
                  : 'The screening form needs manual review.',
              question: field.question,
            }
          if (field.question.type === 'select') await field.input.selectOption({ label: answer })
          else if (field.question.type === 'radio') {
            const name = await field.input.getAttribute('name')
            const radios = form.container.getByLabel(answer, { exact: true })
            let selected = false
            for (let index = 0; index < (await radios.count()); index++)
              if ((await radios.nth(index).getAttribute('name')) === name) {
                await radios.nth(index).check()
                selected = true
                break
              }
            if (!selected)
              return {
                status: 'not_submitted',
                reason: 'Could not identify the selected screening answer.',
                question: field.question,
              }
          } else await field.input.fill(answer)
          answered++
          handled.add(signature)
        }
        const next = form.container
          .getByRole('button', { name: /^(?:submit|save|next|send|apply)$/i })
          .filter({ visible: true })
        if ((await next.count()) !== 1)
          return {
            status: 'not_submitted',
            reason: 'Could not identify the screening form submit control.',
          }
        if (this.stopped())
          return { status: 'not_submitted', reason: 'Stopped before submitting screening answers.' }
        await next.click({ noWaitAfter: true })
        await this.page!.waitForTimeout(700)
      } else await this.page!.waitForTimeout(400)
    }
    return {
      status: 'unknown',
      reason: 'Submission was attempted, but Naukri did not confirm the outcome.',
    }
  }
  async screenshot(path: string): Promise<string | null> {
    if (
      !this.page ||
      this.page.isClosed() ||
      (await this.visible(this.page.locator('input[type="password"]')))
    )
      return null
    await this.page.screenshot({ path, fullPage: false, timeout: 5000 })
    return path
  }
  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined)
    await this.browser?.close().catch(() => undefined)
  }
}
