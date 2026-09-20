# Naukri Autopilot

A Windows desktop app for scheduled Naukri profile updates and applications that meet your explicit job preferences. Runs locally with Electron, React, TypeScript, Playwright, and SQLite.

## Start developing

Prerequisites: Windows 10/11 x64, Node.js 22.12+ (Node 24 recommended), and Google Chrome. Use npm 11 if npm 10 reports dependency-resolution errors.

```powershell
npm ci
npm run dev
```

For a production build and local preview:

```powershell
npm run build
npm run preview
```

Build a Windows installer with `npm run dist`. Output appears in `release/`. The installed app includes its runtime; end users need Google Chrome but do not need Node.js or Visual Studio. The personal-use installer is unsigned. Updates are installed manually.

## First-time setup

1. Open **Profile → Connect account**. Log in directly in the separate Chrome window. Passwords and login screens are never recorded. The browser closes after the authenticated profile has been verified.
2. Choose a PDF, DOC, or DOCX resume. A copy is saved locally; replacing the source file outside the app does not change that copy. Naukri's own upload limits still apply.
3. In **Settings**, enter title variations, required skills, experience, locations, salary, exclusions, and any screening facts you want to provide. Blank optional filters impose no requirement.
4. Use **Find matching jobs** to preview your filters. A preview does not upload your resume, change your headline, or submit applications. It can reconcile existing uncertain applications by reading their status.
5. Set schedules and choose **Start autopilot**. Defaults: profile refresh at 09:00 every day, applications at 09:15 on weekdays, Asia/Kolkata, and 10 application submissions per day.

**Start autopilot enables future schedules; it does not start a run immediately.** The dashboard shows the next run times in your configured timezone. Use **Refresh profile**, **Find matching jobs**, or **Jobs → Apply now** for an immediate run. At least one schedule must be enabled. Pause remains available while you have unsaved preferences.

Use **Profile → Check connection** to verify a saved login in visible Chrome without uploading a resume or submitting applications. A saved session is labeled as unchecked until verified. If Naukri shows a security check, this action leaves Chrome open for up to two minutes for you to resolve it manually; Stop cancels the check.

An **Access blocked** message is different from an expired login. The app keeps your encrypted session, pauses scheduling, and turns off background browsing after a block. Visible Chrome is the default for new installations. Check the connection before restarting autopilot; a successful check does not automatically resume schedules. If Naukri still denies access, try later. A page-layout failure also retains the saved login and reports the actual failed operation.

Closing the dashboard keeps the app in the Windows tray. **Quit** ends scheduling; **Pause** disables automatic runs and stops further browser actions. Runs require an awake computer, network access, and a running app. Launch-at-login is available in the installed app. After sleep or downtime, each enabled workflow catches up once rather than replaying a backlog.

## How matching and applications work

- Any target title and any allowed location may match; all required skills must be present. Word-aware matching avoids confusing Java and JavaScript. Add alternative spellings yourself.
- Your experience must fall within the advertised range. The advertised salary ceiling must meet your chosen minimum; this is not a promise of an offer at that salary. Salary parsing supports explicit annual INR and LPA.
- Missing mandatory information goes to **Needs attention**. Excluded companies and keywords reject a listing. Newer qualifying jobs come first, with preferred skills breaking date ties.
- A run inspects at most 100 unique jobs. Application runs first upload and verify your selected resume, since Naukri uses the profile resume when applying.
- Applications run one at a time. A durable record reserves a slot before the first Apply click. Manual and scheduled runs share the same daily quota and browser lock.
- Unknown screening questions and employer-site redirects are queued for attention. Save an answer from the Jobs view to retry that question on a future run. Answers are reused only for the same question meaning, input type, and complete option set. Candidate facts are used only for explicit, unit-qualified questions.
- A timeout or crash after clicking Apply produces **Outcome unknown**. The slot remains counted on the submission day. Later runs check Naukri for confirmation before retrying anything; unresolved outcomes never automatically resubmit. If Naukri cannot confirm it, inspect the job manually. V1 deliberately offers no forced retry for an uncertain submission.
- CAPTCHA, expired sessions, and unexpected page structure pause autopilot. Use **Check connection** for blocked access and **Reconnect** for an expired login. If a site-layout change persists, the adapter needs updating; reconnecting cannot fix incompatible selectors.

## Local data and privacy

Data is stored in `%LOCALAPPDATA%\NaukriAutopilot`:

| Item                                                           | Storage                                                              |
| -------------------------------------------------------------- | -------------------------------------------------------------------- |
| Login session                                                  | `login.session`, encrypted with Electron safeStorage / Windows DPAPI |
| Settings, candidate facts, saved answers, jobs, attempts, runs | `autopilot.db` (SQLite, local and unencrypted)                       |
| Imported resumes                                               | `resumes/<sha256>/<original filename>`                               |
| Run screenshots                                                | `screenshots/`, retained for 30 days by default                      |

The app does not use your everyday Chrome profile, collect your password, run a web server, send telemetry, or use cloud AI. Chrome still connects to Naukri and the resources that Naukri loads; resumes and applications are sent through Naukri as intended. DPAPI protects saved sessions against other Windows accounts, not software running as your Windows user. Resume copies, screenshots, and database contents can contain personal information.

**Disconnect** removes the saved login session and pauses scheduling. It does not delete your activity, resume copies, settings, or account on Naukri. **Open data folder** shows all local files. Quit the app before manually removing its data folder. Uninstall preserves data for reinstalls; it does not delete your Naukri account.

Screenshots are captured after non-login runs when a page is available. Login pages are excluded, and crashed browsers may have no screenshot; the run explains missing evidence. Evidence is local, and application deduplication history survives screenshot cleanup. Success requires a Naukri confirmation and is never inferred from a screenshot alone.

## Verification

```powershell
npm run typecheck
npm test
npm run test:desktop
npm run dist
npm run test:packaged
```

Unit tests cover matching, conservative parsing, screening answers, timezone/DST scheduling, SQLite quota reservations, deduplication, interruption recovery, and screenshot cleanup. Desktop tests run the actual Electron app with an isolated temporary data folder and verify Windows session encryption. Browser-adapter tests intercept every network request with local fixtures; they never contact Naukri or submit a real application. Browser tests require installed Chrome. After building the installer, the packaged smoke test launches the bundled executable and browser worker with Node removed from PATH.

**Live integration status:** the authenticated Naukri screens cannot be verified without your manual login and configured resume/preferences. Passing fixture tests establishes app behavior, not current Naukri compatibility. Before relying on unattended operation, verify a connection, one profile refresh, a match preview, and one qualifying application in the app. The adapter stops on unsupported pages instead of guessing. Headless access and the lifetime of restored sessions are controlled by Naukri. The app does not bypass challenges or guarantee recruiter ranking, interviews, or callbacks.

## Code map

- `src/core`: pure matching, scheduling, and screening-answer rules.
- `src/automation`: Chrome adapter, parsers, and isolated utility-process worker. All Naukri page selectors live here.
- `src/main`: single-instance desktop lifecycle, validated IPC, SQLite migrations, scheduling, session encryption, and worker supervision.
- `src/shared`: typed contracts and settings validation.
- `src/preload`: narrowly scoped desktop bridge; no raw filesystem or IPC access in the renderer.
- `src/renderer`: dashboard, job queue, run evidence, profile, and preferences.
- `tests`: unit tests and offline desktop/browser fixtures.

V1 supports one account, one selected resume, and applications completed inside Naukri. External career sites, multiple resume mappings, AI matching, macOS packaging, cloud synchronization, and automatic app updates are outside this version.
