import { test, expect } from '@playwright/test'
import { NaukriAdapter, AttentionError } from '../../src/automation/naukri'
import { defaultSettings } from '../../src/shared/settings'
import { makeJob } from '../fixtures/data'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const jobUrl = makeJob().url
const authLink = '<a href="/mnjuser/profile">View profile</a>'
const profile = `<!doctype html><html><body>${authLink}<h1>Your profile</h1><div id="lazyResumeHead"><h2>Resume headline</h2><p id="headline"></p><button class="edit" onclick="document.querySelector('dialog').showModal()">Edit</button></div><input id="attachCV" type="file" accept=".pdf"><p id="filename"></p><p id="feedback"></p><dialog><textarea id="resumeHeadlineTxt"></textarea><button onclick="localStorage.setItem('headline',document.querySelector('textarea').value);document.querySelector('dialog').close()">Save</button></dialog><script>document.querySelector('#headline').textContent=localStorage.getItem('headline')||'Frontend developer';document.querySelector('#filename').textContent=localStorage.getItem('resume')||'';document.querySelector('#attachCV').onchange=e=>{localStorage.setItem('resume',e.target.files[0].name);document.querySelector('#feedback').textContent='Resume uploaded successfully'}</script></body></html>`
const listing = (mode: string) =>
  `<!doctype html><html><body>${authLink}<h1>Senior Frontend Developer</h1><div class="company-name">Acme</div><div class="job-description">Build accessible React TypeScript applications.</div><div class="exp">3-6 years</div><div class="salary">20-30 LPA</div><div class="loc">Bengaluru (Hybrid)</div><div class="posting-date">Posted: 1 day ago</div>${mode === 'closed' ? '<p>This job has expired</p>' : mode === 'applied' ? '<button>Applied</button>' : mode === 'external' ? '<a href="https://careers.example.org/role">Apply on company website</a>' : `<button id="apply" onclick="${mode === 'immediate' ? "this.textContent='Applied'" : "document.querySelector('dialog').showModal()"}">Apply</button>`}<dialog role="dialog"><label for="answer">${mode === 'known' ? 'Notice period (in days)' : 'How many years of Rust experience do you have?'}</label><input id="answer"><button onclick="document.querySelector('#apply').textContent='Applied';document.querySelector('dialog').close()">Submit</button></dialog></body></html>`

async function fixture(mode: string) {
  const adapter = new NaukriAdapter(
    () => false,
    () => undefined,
  )
  await adapter.open(null, true)
  await adapter.context!.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname !== 'www.naukri.com') {
      await route.abort()
      return
    }
    if (url.pathname === '/mnjuser/profile')
      await route.fulfill({ contentType: 'text/html', body: profile })
    else if (url.pathname.startsWith('/job-listings-'))
      await route.fulfill({ contentType: 'text/html', body: listing(mode) })
    else
      await route.fulfill({
        contentType: 'text/html',
        body: `${authLink}<a href="${jobUrl}">Senior Frontend Developer</a>`,
      })
  })
  await adapter.verifySession()
  return adapter
}

test('resume upload and headline rotation require saved page verification', async () => {
  const adapter = await fixture('immediate')
  const directory = await mkdtemp(join(tmpdir(), 'autopilot-resume-'))
  try {
    const path = join(directory, 'resume.pdf')
    await writeFile(path, '%PDF-1.4 fixture')
    expect((await adapter.uploadResume(path)).status).toBe('succeeded')
    const result = await adapter.rotateHeadline(['Frontend developer', 'React engineer'], 0)
    expect(result.step.status).toBe('succeeded')
    expect(result.nextIndex).toBe(0)
    expect(await adapter.page!.locator('#headline').innerText()).toBe('React engineer')
  } finally {
    await adapter.close()
    await rm(directory, { recursive: true, force: true })
  }
})
test('discovers unique jobs and extracts explicit requirements', async () => {
  const adapter = await fixture('immediate')
  try {
    const urls = await adapter.discover({
      ...defaultSettings.filters,
      titles: ['Frontend Developer'],
    })
    expect(urls).toEqual([jobUrl])
    const job = await adapter.inspect(jobUrl)
    expect(job).toMatchObject({
      company: 'Acme',
      experienceMin: 3,
      experienceMax: 6,
      salaryMinLpa: 20,
      salaryMaxLpa: 30,
      workMode: 'hybrid',
    })
  } finally {
    await adapter.close()
  }
})
for (const mode of ['immediate', 'known', 'unknown', 'external', 'applied', 'closed']) {
  test(`application fixture: ${mode}`, async () => {
    const adapter = await fixture(mode)
    try {
      const job = await adapter.inspect(jobUrl)
      if (mode === 'applied' || mode === 'closed') {
        expect(job.status).toBe(mode)
        return
      }
      const result = await adapter.apply(job, [], {
        ...defaultSettings.candidate,
        noticePeriodDays: 30,
      })
      expect(result.status).toBe(
        ['immediate', 'known'].includes(mode) ? 'applied' : 'not_submitted',
      )
      if (mode === 'unknown') expect(result.question?.question).toContain('Rust')
      if (mode === 'external') expect(result.externalUrl).toBe('https://careers.example.org/role')
    } finally {
      await adapter.close()
    }
  })
}
test('login screens are not captured and expired sessions stop operations', async () => {
  const adapter = await fixture('immediate')
  try {
    await adapter.page!.setContent('<input type="password"><p>Log in</p>')
    await expect(adapter.assertReady()).rejects.toBeInstanceOf(AttentionError)
    expect(await adapter.screenshot('test-results/should-not-exist.png')).toBeNull()
  } finally {
    await adapter.close()
  }
})

test('answers all fields before submitting a multi-question form', async () => {
  const adapter = await fixture('known')
  try {
    const job = await adapter.inspect(jobUrl)
    await adapter.page!.locator('dialog').evaluate((dialog) => {
      dialog.innerHTML = `<label for="answer">Notice period (in days)</label><input id="answer" required>
        <label for="experience">Total experience (years)</label><input id="experience" required>
        <button onclick="if(document.querySelector('#answer').value && document.querySelector('#experience').value){document.querySelector('#apply').textContent='Applied';document.querySelector('dialog').close()}">Submit</button>`
    })
    const result = await adapter.apply(job, [], {
      ...defaultSettings.candidate,
      noticePeriodDays: 30,
      totalExperience: 4,
    })
    expect(result.status).toBe('applied')
  } finally {
    await adapter.close()
  }
})

for (const kind of ['radio', 'select'] as const) {
  test(`uses exact saved option answers for ${kind} questions`, async () => {
    const adapter = await fixture('known')
    try {
      const job = await adapter.inspect(jobUrl)
      await adapter.page!.locator('dialog').evaluate((dialog, kind) => {
        const options =
          kind === 'select'
            ? '<label for="option">Are you willing to relocate?</label><select id="option"><option value="">Choose</option><option>Yes</option><option>No</option></select>'
            : '<fieldset><legend>Are you willing to relocate?</legend><label><input type="radio" name="relocate" value="Yes">Yes</label><label><input type="radio" name="relocate" value="No">No</label></fieldset>'
        dialog.innerHTML =
          options +
          `<button onclick="document.querySelector('#apply').textContent='Applied';document.querySelector('dialog').close()">Submit</button>`
      }, kind)
      const result = await adapter.apply(
        job,
        [
          {
            id: 'option',
            question: 'Are you willing to relocate?',
            type: kind,
            options: ['Yes', 'No'],
            answer: 'No',
          },
        ],
        defaultSettings.candidate,
      )
      expect(result.status).toBe('applied')
    } finally {
      await adapter.close()
    }
  })
}
