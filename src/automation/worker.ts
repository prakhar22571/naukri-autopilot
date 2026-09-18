import {
  NaukriAdapter,
  AttentionError,
  StructureError,
  StoppedError,
  SubmissionNotStartedError,
} from './naukri'
import { matchJob, rankJobs } from '../core/matching'
import { resolveAnswer } from '../core/answers'
import type { WorkerInput, WorkerMessage, WorkerRequest } from '../shared/protocol'
import type { Job, Run, StepResult } from '../shared/types'

let stopped = false,
  sequence = 0
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
const send = (message: WorkerMessage) => process.parentPort.postMessage(message)
const rpc = <T>(request: WorkerRequest): Promise<T> =>
  new Promise((resolve, reject) => {
    const id = ++sequence
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Local storage did not acknowledge the operation.'))
    }, 15_000)
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    })
    send({ type: 'rpc', id, request })
  })
process.parentPort.on('message', (event) => {
  const message = event.data
  if (message.type === 'stop') stopped = true
  else if (message.type === 'reply') {
    const waiter = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) waiter?.reject(new Error(message.error))
    else waiter?.resolve(message.result)
  } else if (message.type === 'start') void run(message)
})
send({ type: 'ready' })

async function run(input: WorkerInput): Promise<void> {
  const adapter = new NaukriAdapter(
    () => stopped,
    (message) => send({ type: 'progress', message }),
  )
  let status: Run['status'] = 'succeeded',
    message = '',
    inspected = 0,
    submitted = 0
  let screenshotPath: string | null = null,
    evidenceNote: string | null = null,
    authenticated = false
  const steps: StepResult[] = []
  try {
    await adapter.open(
      input.auth,
      input.workflow === 'connect' ? false : input.settings.backgroundBrowser,
    )
    if (input.workflow === 'connect') {
      const state = await adapter.login()
      await rpc({ method: 'saveSession', state })
      authenticated = true
      send({
        type: 'connection',
        connected: true,
        message: 'Connected to Naukri. Your encrypted session is saved on this computer.',
      })
      message = 'Connected to Naukri.'
    } else {
      await adapter.verifySession()
      authenticated = true
      send({ type: 'connection', connected: true, message: 'Naukri session verified.' })
      if (input.workflow === 'profile') {
        send({ type: 'progress', message: 'Uploading your selected resume…' })
        steps.push(await adapter.uploadResume(input.resume!.path))
        if (input.settings.rotateHeadlines) {
          const headline = await adapter.rotateHeadline(
            input.settings.headlines,
            input.headlineIndex,
          )
          steps.push(headline.step)
          if (headline.step.status === 'succeeded')
            await rpc({ method: 'headlineIndex', value: headline.nextIndex })
        }
        status = steps.every((s) => ['succeeded', 'skipped'].includes(s.status))
          ? 'succeeded'
          : 'partial'
        message =
          status === 'succeeded'
            ? 'Your profile update is verified.'
            : 'Some profile changes could not be verified. Review the run details.'
      } else {
        for (const attempt of input.unresolved) {
          adapter.checkStop()
          send({
            type: 'progress',
            message: `Checking a previous submission: ${attempt.job.title}`,
          })
          const outcome = await adapter.reconcile(attempt.job.url)
          await rpc({
            method: 'finishAttempt',
            attemptId: attempt.id,
            status: outcome,
            reason:
              outcome === 'applied'
                ? 'Naukri confirms the previous application.'
                : 'Previous application outcome remains unknown. Automatic retry is blocked.',
          })
        }
        if (input.workflow === 'applications') {
          if ((await rpc<number>({ method: 'remainingAllowance' })) === 0) {
            message = 'Previous outcomes were checked. Your daily application allowance is used.'
            return
          }
          send({
            type: 'progress',
            message: 'Verifying the resume that Naukri will use for your applications…',
          })
          const resumeStep = await adapter.uploadResume(input.resume!.path)
          steps.push(resumeStep)
          if (resumeStep.status !== 'succeeded')
            throw new StructureError(
              'The selected resume could not be verified on Naukri. No applications were started.',
            )
        }
        const urls = await adapter.discover(input.settings.filters)
        const answeredJobs = input.retryJobs.filter(
          (j) =>
            j.question &&
            resolveAnswer(j.question, input.settings.answers, input.settings.candidate) !== null,
        )
        const unique = [
          ...new Set([
            ...answeredJobs.map((j) => j.url),
            ...urls,
            ...input.retryJobs.map((j) => j.url),
          ]),
        ].slice(0, 100)
        const eligible: Job[] = []
        for (const url of unique) {
          adapter.checkStop()
          send({ type: 'progress', message: `Inspecting job ${inspected + 1} of ${unique.length}` })
          const job = await adapter.inspect(url)
          inspected++
          if (!['applied', 'closed'].includes(job.status)) {
            const result = matchJob(job, input.settings.filters)
            job.status = result.status
            job.reasons = result.reasons
            if (job.status === 'matched') eligible.push(job)
          }
          await rpc({ method: 'saveJob', job })
        }
        if (input.workflow === 'preview')
          message = `Preview complete: ${eligible.length} of ${inspected} jobs match your filters. No applications were submitted.`
        else {
          for (const candidate of rankJobs(eligible, input.settings.filters)) {
            adapter.checkStop()
            send({ type: 'progress', message: `Preparing application: ${candidate.title}` })
            const job = await adapter.inspect(candidate.url)
            const match = matchJob(job, input.settings.filters)
            if (['applied', 'closed'].includes(job.status) || match.status !== 'matched') {
              if (!['applied', 'closed'].includes(job.status)) {
                job.status = match.status
                job.reasons = match.reasons
              }
              await rpc({ method: 'saveJob', job })
              continue
            }
            job.status = 'matched'
            job.reasons = match.reasons
            await rpc({ method: 'saveJob', job })
            const attemptId = await rpc<string | null>({ method: 'reserve', jobId: job.id })
            if (!attemptId) {
              if ((await rpc<number>({ method: 'remainingAllowance' })) === 0) break
              continue
            }
            if (stopped) {
              await rpc({
                method: 'finishAttempt',
                attemptId,
                status: 'not_submitted',
                reason: 'Stopped before clicking Apply.',
              })
              adapter.checkStop()
            }
            try {
              const result = await adapter.apply(
                job,
                input.settings.answers,
                input.settings.candidate,
              )
              await rpc({
                method: 'finishAttempt',
                attemptId,
                status: result.status,
                reason: result.reason,
              })
              if (result.question || result.externalUrl)
                await rpc({
                  method: 'saveJob',
                  job: {
                    ...job,
                    status: 'attention',
                    reasons: [result.reason],
                    question: result.question,
                    externalUrl: result.externalUrl,
                  },
                })
              if (result.status === 'applied') submitted++
              if (result.status === 'unknown') status = 'partial'
              if (result.status === 'not_submitted' && status === 'succeeded') status = 'partial'
            } catch (error) {
              await rpc({
                method: 'finishAttempt',
                attemptId,
                status: error instanceof SubmissionNotStartedError ? 'not_submitted' : 'unknown',
                reason:
                  error instanceof SubmissionNotStartedError
                    ? error.message
                    : 'The application was interrupted. Its outcome must be verified before any retry.',
              })
              throw error
            }
            if (submitted >= input.settings.dailyLimit) break
            await adapter.page!.waitForTimeout(2000)
          }
          message = `Run complete: ${submitted} application${submitted === 1 ? '' : 's'} confirmed from ${inspected} inspected jobs.`
        }
      }
    }
  } catch (error) {
    if (error instanceof StoppedError) {
      status = 'stopped'
      message = error.message
    } else if (error instanceof AttentionError) {
      status = 'attention'
      message = error.message
      send({ type: 'connection', connected: false, message })
    } else if (error instanceof StructureError) {
      status = 'attention'
      message = error.message
      send({
        type: 'connection',
        connected: false,
        message: 'Naukri’s page could not be verified. Review the run before reconnecting.',
      })
    } else {
      status = 'failed'
      // Do not persist raw Playwright errors, which can include page data or form values.
      message =
        error instanceof Error &&
        /Chrome could not start|Local storage|browser window was closed/.test(error.message)
          ? error.message
          : 'The browser operation could not finish. Check your connection and run evidence.'
    }
  } finally {
    if (input.workflow !== 'connect') {
      try {
        screenshotPath = await adapter.screenshot(input.screenshotPath)
      } catch {}
      if (!screenshotPath)
        evidenceNote =
          'No screenshot was captured: the browser was unavailable or a login screen was visible.'
    } else evidenceNote = 'Screenshots are disabled during manual login.'
    if (authenticated && status !== 'attention') {
      try {
        await rpc({ method: 'saveSession', state: await adapter.state() })
      } catch {
        status = 'partial'
        message += ' The refreshed session could not be saved; reconnect before the next run.'
      }
    }
    await adapter.close()
    send({
      type: 'done',
      status,
      message,
      steps,
      inspected,
      submitted,
      screenshotPath,
      evidenceNote,
    })
    setTimeout(() => process.exit(0), 50)
  }
}
