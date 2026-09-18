import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { DateTime } from 'luxon'
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BriefcaseBusiness,
  CalendarClock,
  Check,
  CheckCheck,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileText,
  FolderOpen,
  History,
  LayoutDashboard,
  Link2,
  LoaderCircle,
  Monitor,
  Pause,
  Play,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Target,
  Trash2,
  Upload,
  X,
  Zap,
} from 'lucide-react'
import type { Job, Run, Schedule, Settings, Snapshot, Workflow } from '../../shared/types'

type View = 'Overview' | 'Jobs' | 'Runs' | 'Profile' | 'Settings'
const views = [
  { label: 'Overview' as View, icon: LayoutDashboard },
  { label: 'Jobs' as View, icon: BriefcaseBusiness },
  { label: 'Runs' as View, icon: History },
  { label: 'Profile' as View, icon: FileText },
  { label: 'Settings' as View, icon: Settings2 },
]
const split = (value: string) =>
  value
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter(Boolean)
const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : 'Something went wrong. Please try again.').replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    '',
  )
const when = (date: string | null, zone: string) =>
  date ? DateTime.fromISO(date).setZone(zone).toFormat('dd MMM, h:mm a') : 'Not scheduled'
const statusLabel = (status: string) =>
  ({
    attention: 'Needs attention',
    unknown: 'Outcome unknown',
    not_submitted: 'Not submitted',
    submitting: 'Submitting',
    matched: 'Matched',
    rejected: 'Not a match',
  })[status] ?? status.replace(/^./, (c) => c.toUpperCase())
const workflowLabel = (workflow: Workflow) =>
  ({
    profile: 'Profile refresh',
    applications: 'Job applications',
    preview: 'Match preview',
    connect: 'Account connection',
  })[workflow]

function Badge({ status }: { status: string }) {
  return (
    <span className={`badge badge-${status}`}>
      <span />
      {statusLabel(status)}
    </span>
  )
}
function Button({
  children,
  onClick,
  variant = 'secondary',
  disabled = false,
  title,
}: {
  children: ReactNode
  onClick: () => void
  variant?: string
  disabled?: boolean
  title?: string
}) {
  return (
    <button title={title} className={`button ${variant}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  )
}
function ListInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[]
  onChange: (value: string[]) => void
  placeholder?: string
}) {
  const [text, setText] = useState(value.join(', ')),
    [focused, setFocused] = useState(false)
  const joined = value.join(', ')
  useEffect(() => {
    if (!focused) setText(joined)
  }, [joined, focused])
  return (
    <input
      placeholder={placeholder}
      value={text}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        setText(e.target.value)
        onChange(split(e.target.value))
      }}
    />
  )
}
function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  hint?: string
}) {
  return (
    <label className="toggle-row">
      <span>
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <i />
    </label>
  )
}
function Empty({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode
  title: string
  description: string
  children?: ReactNode
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  )
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [draft, setDraft] = useState<Settings | null>(null)
  const [view, setView] = useState<View>('Overview')
  const [error, setError] = useState(''),
    [toast, setToast] = useState(''),
    [busy, setBusy] = useState(false)
  const [selectedRun, setSelectedRun] = useState<Run | null>(null),
    [image, setImage] = useState<string | null>(null)
  const [jobFilter, setJobFilter] = useState('all'),
    [query, setQuery] = useState('')
  const [chartDays, setChartDays] = useState(30)
  const [answerJob, setAnswerJob] = useState<Job | null>(null),
    [answerValue, setAnswerValue] = useState('')
  const lastSettings = useRef<Settings | null>(null)
  const reload = useCallback(async () => {
    const current = await window.autopilot.snapshot(),
      previousSettings = lastSettings.current
    lastSettings.current = current.settings
    setSnapshot(current)
    setDraft((previous) =>
      !previous || JSON.stringify(previous) === JSON.stringify(previousSettings)
        ? structuredClone(current.settings)
        : previous,
    )
  }, [])
  useEffect(() => {
    void reload().catch((e) => setError(errorText(e)))
    return window.autopilot.onChange(() => {
      void reload().catch((e) => setError(errorText(e)))
    })
  }, [reload])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 4500)
    return () => clearTimeout(timer)
  }, [toast])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectedRun(null)
        setAnswerJob(null)
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [])
  const act = async (action: () => Promise<unknown>, success?: string) => {
    setBusy(true)
    setError('')
    try {
      await action()
      await reload()
      if (success) setToast(success)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  if (!snapshot || !draft)
    return (
      <div className="loading">
        <Zap size={32} />
        <h2>Naukri Autopilot</h2>
        <p>{error || 'Opening your workspace…'}</p>
      </div>
    )
  const settings = snapshot.settings
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings)
  const active = !!snapshot.activeRunId
  const attention = snapshot.jobs.filter((j) => ['attention', 'unknown'].includes(j.status))
  const update = (patch: Partial<Settings>) => setDraft({ ...draft, ...patch })
  const save = () =>
    act(async () => {
      const cleaned = { ...draft, headlines: draft.headlines.map((h) => h.trim()).filter(Boolean) }
      await window.autopilot.saveSettings(cleaned)
      setDraft(structuredClone(cleaned))
    }, 'Settings saved on this computer.')
  const start = (workflow: Workflow) =>
    act(async () => {
      if (dirty && workflow !== 'connect')
        throw new Error('Save or discard your settings changes before starting a run.')
      await window.autopilot.start(workflow)
    })
  const toggleActive = () =>
    act(async () => {
      if (dirty) throw new Error('Save your settings changes before changing autopilot mode.')
      const changed = { ...settings, active: !settings.active }
      await window.autopilot.saveSettings(changed)
      setDraft(changed)
    })
  const showRun = (run: Run) => {
    setSelectedRun(run)
    setImage(null)
    if (run.screenshotId)
      void window.autopilot
        .screenshot(run.screenshotId)
        .then(setImage)
        .catch((e) => setError(errorText(e)))
  }
  const setupSteps = [
    {
      title: 'Connect your account',
      description: 'Log in yourself in a Chrome window.',
      done: snapshot.connected,
      action: () => start('connect'),
      label: 'Connect',
    },
    {
      title: 'Add your resume',
      description: 'One resume, ready for every opportunity.',
      done: !!snapshot.resume,
      action: () => setView('Profile'),
      label: 'Add resume',
    },
    {
      title: 'Define your next role',
      description: 'Tell autopilot what a good match looks like.',
      done: !!settings.filters.titles.length,
      action: () => setView('Settings'),
      label: 'Set preferences',
    },
  ]
  const completed = setupSteps.filter((s) => s.done).length
  const profileSuccess = snapshot.runs.filter(
    (r) => r.workflow === 'profile' && r.status === 'succeeded',
  ).length
  const applications = snapshot.jobs.filter((j) => j.status === 'applied').length
  const today = DateTime.now().setZone(settings.timezone)
  const chart = Array.from({ length: chartDays }, (_, index) => {
    const day = today.minus({ days: chartDays - 1 - index })
    const runs = snapshot.runs.filter(
      (r) =>
        DateTime.fromISO(r.startedAt).setZone(settings.timezone).toISODate() === day.toISODate(),
    )
    return {
      label: day.toFormat('dd'),
      full: day.toFormat('dd MMM'),
      applications: runs.reduce((sum, r) => sum + r.submitted, 0),
      updates: runs.filter((r) => r.workflow === 'profile' && r.status === 'succeeded').length,
    }
  })
  const chartMax = Math.max(5, ...chart.map((d) => d.applications + d.updates))
  const runTable = (runs: Run[]) =>
    runs.length ? (
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Activity</th>
              <th>Started</th>
              <th>Result</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td>
                  <div className="table-title">
                    <span className="mini-icon">
                      {run.workflow === 'profile' ? (
                        <FileText size={16} />
                      ) : run.workflow === 'connect' ? (
                        <Link2 size={16} />
                      ) : (
                        <BriefcaseBusiness size={16} />
                      )}
                    </span>
                    <div>
                      <strong>{workflowLabel(run.workflow)}</strong>
                      <small>{run.trigger === 'scheduled' ? 'Scheduled run' : 'Manual run'}</small>
                    </div>
                  </div>
                </td>
                <td>{when(run.startedAt, settings.timezone)}</td>
                <td>
                  <Badge status={run.status} />
                </td>
                <td>
                  <button className="text-button" onClick={() => showRun(run)}>
                    {run.screenshotId ? 'View screenshot' : 'View details'}
                    <ArrowUpRight size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <Empty
        icon={<History />}
        title="Your story starts here"
        description="Run your first profile refresh or find matching jobs. Every run will appear here."
      />
    )

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-symbol">
            <Zap fill="currentColor" size={22} />
          </span>
          <div>
            naukri<span>AUTOPILOT</span>
          </div>
        </div>
        <div className="workspace-label">YOUR WORKSPACE</div>
        <nav aria-label="Main navigation">
          {views.map(({ label, icon: Icon }) => (
            <button
              key={label}
              className={view === label ? 'nav-item selected' : 'nav-item'}
              onClick={() => setView(label)}
            >
              <Icon size={19} />
              {label}
              {label === 'Jobs' && attention.length > 0 && (
                <span className="nav-count">{attention.length}</span>
              )}
              {label === view && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-note">
            <span className="local-dot" />
            LOCAL BY DESIGN
            <p>
              Your career. Your computer.
              <br />
              Your account stays yours.
            </p>
          </div>
          <div className="device">
            <Monitor size={19} />
            <div>
              This computer<span>Windows · Local workspace</span>
            </div>
            <ShieldCheck size={16} />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={13} />
            <strong>{view}</strong>
          </div>
          <div className="topbar-right">
            <span className="private-label">
              <ShieldCheck size={15} />
              Only on your device
            </span>
            <span className="topbar-divider" />
            <span className="avatar">You</span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {view === 'Overview'
                  ? today.toFormat('EEEE, d MMMM yyyy').toUpperCase()
                  : 'NAUKRI AUTOPILOT'}
              </div>
              <h1>
                {
                  {
                    Overview: 'Make your next move.',
                    Jobs: 'Good fits. Fresh opportunities.',
                    Runs: 'Every run, accounted for.',
                    Profile: 'Keep your best self visible.',
                    Settings: 'Set it up your way.',
                  }[view]
                }
              </h1>
              <p>
                {
                  {
                    Overview: 'A little consistency today. More possibilities tomorrow.',
                    Jobs: 'Your rules decide what qualifies. You can see exactly why.',
                    Runs: 'A clear record of what happened, with evidence to match.',
                    Profile: 'A fresh resume and a headline that tells your story.',
                    Settings: 'Choose the roles, the rhythm, and the answers that work for you.',
                  }[view]
                }
              </p>
            </div>
            <Button
              variant={settings.active ? 'secondary' : 'primary'}
              onClick={toggleActive}
              disabled={busy}
            >
              {settings.active ? <Pause size={16} /> : <Play size={16} />}
              {settings.active ? 'Pause autopilot' : 'Start autopilot'}
            </Button>
          </div>
          {error && (
            <div className="notice error" role="alert">
              <CircleHelp size={19} />
              <span>{error}</span>
              <button aria-label="Dismiss error" onClick={() => setError('')}>
                <X size={17} />
              </button>
            </div>
          )}
          {toast && (
            <div className="notice success" role="status">
              <CheckCheck size={19} />
              <span>{toast}</span>
            </div>
          )}
          {active && (
            <div className="notice running" role="status">
              <LoaderCircle className="spin" size={19} />
              <span>{snapshot.progress}</span>
              <Button onClick={() => act(() => window.autopilot.stop())}>
                <Square size={13} />
                Stop run
              </Button>
            </div>
          )}
          {dirty && (
            <div className="notice unsaved">
              <Settings2 size={18} />
              <span>You have unsaved changes.</span>
              <button className="text-button" onClick={() => setDraft(structuredClone(settings))}>
                Discard
              </button>
              <Button variant="primary" onClick={save} disabled={busy}>
                Save changes
              </Button>
            </div>
          )}

          {view === 'Overview' && (
            <>
              <section className="hero">
                <div className="hero-content">
                  <span className="hero-pill">
                    <span className={settings.active ? 'pulse-dot' : 'paused-dot'} />
                    {settings.active ? 'AUTOPILOT IS ON' : 'READY WHEN YOU ARE'}
                  </span>
                  <h2>Your search, moving forward.</h2>
                  <p>
                    Keep your profile fresh. Find roles that fit.
                    <br />
                    Let the daily routine take care of itself.
                  </p>
                  <div className="hero-actions">
                    <Button
                      variant="light"
                      onClick={() => start('profile')}
                      disabled={active || busy}
                    >
                      <Zap size={16} />
                      Refresh profile
                    </Button>
                    <button
                      className="hero-link"
                      disabled={active || busy}
                      onClick={() => start('preview')}
                    >
                      Find matching jobs <ArrowRight size={17} />
                    </button>
                  </div>
                </div>
                <div className="hero-art" aria-hidden="true">
                  <div className="orbit orbit-one" />
                  <div className="orbit orbit-two" />
                  <div className="orbit orbit-three" />
                  <div className="orbit-center">
                    <Zap size={38} fill="currentColor" />
                  </div>
                  <span className="orbit-node node-one">
                    <FileText size={22} />
                  </span>
                  <span className="orbit-node node-two">
                    <BriefcaseBusiness size={21} />
                  </span>
                  <span className="orbit-node node-three">
                    <Check size={18} />
                  </span>
                  <div className="art-caption">
                    <span />
                    Small actions. Steady momentum.
                  </div>
                </div>
              </section>
              <div className="stats-grid">
                {[
                  {
                    label: 'Profile refreshes',
                    value: profileSuccess,
                    note: 'Verified updates',
                    icon: FileText,
                    color: 'mint',
                  },
                  {
                    label: 'Applications',
                    value: applications,
                    note: 'Confirmed on Naukri',
                    icon: BriefcaseBusiness,
                    color: 'blue',
                  },
                  {
                    label: 'Needs attention',
                    value: attention.length,
                    note: 'Questions or uncertain outcomes',
                    icon: Bell,
                    color: 'amber',
                  },
                  {
                    label: 'Today’s allowance',
                    value: Math.max(0, settings.dailyLimit - snapshot.todayCount),
                    note: `of ${settings.dailyLimit} applications remaining`,
                    icon: Target,
                    color: 'purple',
                  },
                ].map((stat) => (
                  <div className="stat-card" key={stat.label}>
                    <div className="stat-top">
                      <span>{stat.label}</span>
                      <span className={`stat-icon ${stat.color}`}>
                        <stat.icon size={17} />
                      </span>
                    </div>
                    <strong>{stat.value.toString().padStart(2, '0')}</strong>
                    <small>{stat.note}</small>
                  </div>
                ))}
              </div>
              <div className="overview-columns">
                <section className="panel activity-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Your momentum</h2>
                      <p>Every small step adds up.</p>
                    </div>
                    <select
                      className="range-label"
                      aria-label="Activity range"
                      value={chartDays}
                      onChange={(e) => setChartDays(Number(e.target.value))}
                    >
                      <option value={30}>Last 30 days</option>
                      <option value={14}>Last 14 days</option>
                    </select>
                  </div>
                  <div
                    className="chart"
                    aria-label={`Profile updates and applications in the last ${chartDays} days`}
                  >
                    <div className="chart-lines">
                      <span>{chartMax}</span>
                      <span>{Math.ceil(chartMax / 2)}</span>
                      <span>0</span>
                    </div>
                    <div className="chart-bars">
                      {chart.map((day, index) => (
                        <div
                          className="chart-column"
                          key={day.full}
                          title={`${day.full}: ${day.applications} applications, ${day.updates} updates`}
                        >
                          <div className="bar-stack">
                            <div
                              className="bar-applications"
                              style={{ height: `${(day.applications / chartMax) * 140}px` }}
                            />
                            <div
                              className="bar-updates"
                              style={{ height: `${(day.updates / chartMax) * 140}px` }}
                            />
                          </div>
                          <small>
                            {chartDays <= 14 || index % 5 === 0 || index === chartDays - 1
                              ? day.label
                              : ''}
                          </small>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="chart-legend">
                    <span>
                      <i className="legend-mint" />
                      Profile updates
                    </span>
                    <span>
                      <i className="legend-blue" />
                      Applications
                    </span>
                    <small>
                      {today.minus({ days: chartDays - 1 }).toFormat('MMM d')} –{' '}
                      {today.toFormat('MMM d')}
                    </small>
                  </div>
                </section>
                <section className="panel setup-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>
                        {completed === 3 ? 'All set for your next move' : 'Make yourself at home'}
                      </h2>
                      <p>{completed} of 3 essentials ready</p>
                    </div>
                    <span className="setup-number">{completed}/3</span>
                  </div>
                  <div className="setup-track">
                    <span style={{ width: `${(completed / 3) * 100}%` }} />
                  </div>
                  {setupSteps.map((step, index) => (
                    <div className={`setup-step ${step.done ? 'done' : ''}`} key={step.title}>
                      <span className="step-index">
                        {step.done ? <Check size={14} /> : index + 1}
                      </span>
                      <div>
                        <strong>{step.title}</strong>
                        <small>{step.description}</small>
                        {!step.done && (
                          <button
                            className="text-button"
                            onClick={step.action}
                            disabled={busy || active}
                          >
                            {step.label}
                            <ArrowRight size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </section>
              </div>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Recent activity</h2>
                    <p>Nothing happens behind your back.</p>
                  </div>
                  <button className="text-button" onClick={() => setView('Runs')}>
                    View all runs <ArrowRight size={15} />
                  </button>
                </div>
                {runTable(snapshot.runs.slice(0, 4))}
              </section>
              <div className="schedule-strip">
                <Clock3 size={17} />
                <span>
                  Next profile refresh{' '}
                  <strong>{when(snapshot.nextProfile, settings.timezone)}</strong>
                </span>
                <span className="strip-separator" />
                <span>
                  Next applications{' '}
                  <strong>{when(snapshot.nextApplications, settings.timezone)}</strong>
                </span>
                <button className="text-button" onClick={() => setView('Settings')}>
                  Edit schedule <ArrowUpRight size={14} />
                </button>
              </div>
            </>
          )}

          {view === 'Jobs' && (
            <>
              <div className="toolbar">
                <div className="segmented">
                  {[
                    ['all', 'All jobs'],
                    ['matched', 'Matches'],
                    ['applied', 'Applied'],
                    ['attention', 'Needs attention'],
                    ['rejected', 'Not a match'],
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => setJobFilter(key)}
                      className={jobFilter === key ? 'chosen' : ''}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="toolbar-actions">
                  <Button onClick={() => start('preview')} disabled={active || busy}>
                    <Search size={15} />
                    Find jobs
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => start('applications')}
                    disabled={active || busy}
                  >
                    <Play size={15} />
                    Apply now
                  </Button>
                </div>
              </div>
              <label className="search-field">
                <Search size={17} />
                <input
                  aria-label="Search jobs"
                  placeholder="Search by role or company"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <div className="job-list">
                {snapshot.jobs
                  .filter(
                    (job) =>
                      (jobFilter === 'all' ||
                        (jobFilter === 'attention'
                          ? ['attention', 'unknown'].includes(job.status)
                          : job.status === jobFilter)) &&
                      `${job.title} ${job.company}`.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((job) => (
                    <article className="job-card" key={job.id}>
                      <div className="job-company-icon">
                        {job.company.slice(0, 1).toUpperCase() || <BriefcaseBusiness size={20} />}
                      </div>
                      <div className="job-content">
                        <div className="job-title-row">
                          <h2>{job.title}</h2>
                          <Badge status={job.status} />
                        </div>
                        <p>
                          {job.company || 'Company not stated'} <span>·</span>{' '}
                          {job.locations.join(', ') || 'Location not stated'}
                        </p>
                        <div className="job-meta">
                          {job.experienceMin !== null && (
                            <span>
                              {job.experienceMin}–{job.experienceMax} years
                            </span>
                          )}
                          {job.salaryMaxLpa !== null && (
                            <span>
                              ₹{job.salaryMinLpa}–{job.salaryMaxLpa} LPA
                            </span>
                          )}
                          {job.workMode && <span>{job.workMode}</span>}
                        </div>
                        <div className="match-reasons">
                          {job.reasons.map((reason) => (
                            <span key={reason}>
                              {job.status === 'matched' ? (
                                <Check size={12} />
                              ) : (
                                <CircleHelp size={12} />
                              )}
                              {reason}
                            </span>
                          ))}
                        </div>
                        {job.question && (
                          <div className="question-preview">
                            <strong>Screening question</strong>
                            <p>{job.question.question}</p>
                          </div>
                        )}
                        <div className="job-actions">
                          <button
                            className="text-button"
                            onClick={() => act(() => window.autopilot.openJob(job.id))}
                          >
                            Open on Naukri <ArrowUpRight size={14} />
                          </button>
                          {job.question && job.status === 'attention' && (
                            <Button
                              onClick={() => {
                                setAnswerJob(job)
                                setAnswerValue('')
                              }}
                            >
                              <Plus size={14} />
                              Save an answer
                            </Button>
                          )}
                        </div>
                      </div>
                    </article>
                  ))}
              </div>
              {!snapshot.jobs.length && (
                <section className="panel">
                  <Empty
                    icon={<Target />}
                    title="Your next opportunity is out there"
                    description="Set your target roles and filters, then preview matching jobs before your first application run."
                  >
                    <Button onClick={() => setView('Settings')}>
                      Set job preferences <ArrowRight size={15} />
                    </Button>
                  </Empty>
                </section>
              )}
            </>
          )}

          {view === 'Runs' && (
            <>
              <div className="info-line">
                <ShieldCheck size={16} />
                Screenshots stay on your computer for {settings.screenshotRetentionDays} days. Login
                screens are never recorded.
              </div>
              <section className="panel">{runTable(snapshot.runs)}</section>
            </>
          )}

          {view === 'Profile' && (
            <div className="profile-grid">
              <div>
                <section className="panel padded">
                  <div className="section-heading">
                    <div className="section-icon mint">
                      <FileText size={21} />
                    </div>
                    <div>
                      <h2>Your resume</h2>
                      <p>One file, used for profile refreshes and applications.</p>
                    </div>
                  </div>
                  <div className={`resume-drop ${snapshot.resume ? 'has-resume' : ''}`}>
                    <div className="resume-file-icon">
                      <FileText size={35} />
                    </div>
                    <h3>{snapshot.resume?.name ?? 'Put your experience on the page'}</h3>
                    <p>
                      {snapshot.resume
                        ? `Added ${when(snapshot.resume.importedAt, settings.timezone)}`
                        : 'Choose a PDF, DOC, or DOCX from your computer.'}
                    </p>
                    <Button
                      onClick={() =>
                        act(() => window.autopilot.importResume(), 'Resume saved locally.')
                      }
                      disabled={active || busy}
                    >
                      <Upload size={16} />
                      {snapshot.resume ? 'Replace resume' : 'Choose resume'}
                    </Button>
                  </div>
                  <p className="footnote">
                    <ShieldCheck size={14} />A local copy is saved. Your original file stays
                    untouched.
                  </p>
                </section>
                <section className="panel padded">
                  <div className="section-heading">
                    <div className="section-icon purple">
                      <Sparkles size={21} />
                    </div>
                    <div>
                      <h2>A headline with a little variety</h2>
                      <p>Rotate between accurate descriptions of your experience.</p>
                    </div>
                  </div>
                  <Toggle
                    label="Rotate my headline"
                    hint="Use the next variation after each verified update."
                    checked={draft.rotateHeadlines}
                    onChange={(value) => update({ rotateHeadlines: value })}
                  />
                  <Field
                    label="Headline variations"
                    hint="One headline per line. Add at least two when rotation is on; maximum 250 characters each."
                  >
                    <textarea
                      rows={6}
                      placeholder={
                        'Your role | Your strongest skills\nAnother accurate way to describe your experience'
                      }
                      value={draft.headlines.join('\n')}
                      onChange={(e) => update({ headlines: e.target.value.split('\n') })}
                    />
                  </Field>
                  <div className="form-footer">
                    <Button variant="primary" onClick={save} disabled={busy || !dirty}>
                      Save profile settings <Check size={15} />
                    </Button>
                  </div>
                </section>
              </div>
              <div>
                <section className="panel padded">
                  <span className="small-label">ACCOUNT CONNECTION</span>
                  <div className="connection-logo">n</div>
                  <h2>Your Naukri account</h2>
                  <p className="body-copy">{snapshot.connectionMessage}</p>
                  <Badge status={snapshot.connected ? 'connected' : 'disconnected'} />
                  <div className="stack-actions">
                    <Button
                      variant="primary"
                      onClick={() => start('connect')}
                      disabled={busy || active}
                    >
                      <Link2 size={15} />
                      {snapshot.connected ? 'Reconnect account' : 'Connect account'}
                    </Button>
                    {snapshot.connected && (
                      <Button
                        onClick={() => act(() => window.autopilot.disconnect())}
                        disabled={busy || active}
                      >
                        Disconnect
                      </Button>
                    )}
                  </div>
                  <div className="privacy-detail">
                    <ShieldCheck size={20} />
                    <p>
                      You log in directly in Chrome. Autopilot saves an encrypted session on this
                      computer and never reads your password.
                    </p>
                  </div>
                </section>
                <section className="tip-card">
                  <Sparkles size={19} />
                  <h3>Consistency, without the chore.</h3>
                  <p>
                    Regular profile updates help keep your information current. Recruiter visibility
                    and callbacks are never guaranteed.
                  </p>
                </section>
              </div>
            </div>
          )}

          {view === 'Settings' && (
            <div className="settings-layout">
              <div className="settings-main">
                <section className="panel padded">
                  <div className="section-heading">
                    <div className="section-icon mint">
                      <Target size={21} />
                    </div>
                    <div>
                      <h2>What does your next role look like?</h2>
                      <p>
                        Only jobs meeting every required filter qualify for automatic applications.
                      </p>
                    </div>
                  </div>
                  <div className="form-grid">
                    <Field
                      label="Target roles"
                      hint="Comma-separated title variations. At least one must match."
                    >
                      <ListInput
                        placeholder="Frontend Developer, React Developer"
                        value={draft.filters.titles}
                        onChange={(value) =>
                          update({ filters: { ...draft.filters, titles: value } })
                        }
                      />
                    </Field>
                    <Field
                      label="Locations"
                      hint="Any listed location can match. Leave blank for any location."
                    >
                      <ListInput
                        placeholder="Bengaluru, Hyderabad"
                        value={draft.filters.locations}
                        onChange={(value) =>
                          update({ filters: { ...draft.filters, locations: value } })
                        }
                      />
                    </Field>
                    <Field
                      label="Required skills"
                      hint="Every listed skill must appear in the job."
                    >
                      <ListInput
                        placeholder="React, TypeScript"
                        value={draft.filters.requiredSkills}
                        onChange={(value) =>
                          update({ filters: { ...draft.filters, requiredSkills: value } })
                        }
                      />
                    </Field>
                    <Field
                      label="Preferred skills"
                      hint="Used to order otherwise equally recent matches."
                    >
                      <ListInput
                        placeholder="Next.js, PostgreSQL"
                        value={draft.filters.preferredSkills}
                        onChange={(value) =>
                          update({ filters: { ...draft.filters, preferredSkills: value } })
                        }
                      />
                    </Field>
                    <Field label="Your experience (years)">
                      <input
                        type="number"
                        min="0"
                        max="100"
                        step="0.5"
                        placeholder="Any"
                        value={draft.filters.experienceYears ?? ''}
                        onChange={(e) =>
                          update({
                            filters: {
                              ...draft.filters,
                              experienceYears:
                                e.target.value === '' ? null : Number(e.target.value),
                            },
                          })
                        }
                      />
                    </Field>
                    <Field
                      label="Minimum salary (₹ LPA)"
                      hint="The advertised upper salary must reach this amount. Missing salaries need attention."
                    >
                      <input
                        type="number"
                        min="0"
                        step="0.5"
                        placeholder="No minimum"
                        value={draft.filters.minimumSalaryLpa ?? ''}
                        onChange={(e) =>
                          update({
                            filters: {
                              ...draft.filters,
                              minimumSalaryLpa:
                                e.target.value === '' ? null : Number(e.target.value),
                            },
                          })
                        }
                      />
                    </Field>
                    <Field label="Maximum posting age (days)">
                      <input
                        type="number"
                        min="1"
                        max="365"
                        value={draft.filters.maximumAgeDays}
                        onChange={(e) =>
                          update({
                            filters: { ...draft.filters, maximumAgeDays: Number(e.target.value) },
                          })
                        }
                      />
                    </Field>
                    <Field label="Work mode" hint="Leave all unchecked to accept any work mode.">
                      <div className="checkbox-group">
                        {(['remote', 'hybrid', 'office'] as const).map((mode) => (
                          <label key={mode}>
                            <input
                              type="checkbox"
                              checked={draft.filters.workModes.includes(mode)}
                              onChange={(e) =>
                                update({
                                  filters: {
                                    ...draft.filters,
                                    workModes: e.target.checked
                                      ? [...draft.filters.workModes, mode]
                                      : draft.filters.workModes.filter((m) => m !== mode),
                                  },
                                })
                              }
                            />
                            {mode}
                          </label>
                        ))}
                      </div>
                    </Field>
                    <Field label="Excluded companies">
                      <ListInput
                        placeholder="Companies to skip"
                        value={draft.filters.excludedCompanies}
                        onChange={(value) =>
                          update({ filters: { ...draft.filters, excludedCompanies: value } })
                        }
                      />
                    </Field>
                    <Field label="Excluded keywords">
                      <ListInput
                        placeholder="Internship, unpaid"
                        value={draft.filters.excludedKeywords}
                        onChange={(value) =>
                          update({ filters: { ...draft.filters, excludedKeywords: value } })
                        }
                      />
                    </Field>
                  </div>
                </section>
                <section className="panel padded">
                  <div className="section-heading">
                    <div className="section-icon blue">
                      <CalendarClock size={21} />
                    </div>
                    <div>
                      <h2>Find your rhythm</h2>
                      <p>
                        Scheduled runs happen while this computer is awake and the app is running.
                      </p>
                    </div>
                  </div>
                  <div className="form-grid">
                    <Field label="Timezone">
                      <select
                        value={draft.timezone}
                        onChange={(e) => update({ timezone: e.target.value })}
                      >
                        {Array.from(
                          new Set([draft.timezone, ...Intl.supportedValuesOf('timeZone')]),
                        ).map((zone) => (
                          <option key={zone}>{zone}</option>
                        ))}
                      </select>
                    </Field>
                    <Field
                      label="Daily application limit"
                      hint="Includes submissions whose outcomes are still unknown."
                    >
                      <input
                        type="number"
                        min="1"
                        max="100"
                        value={draft.dailyLimit}
                        onChange={(e) => update({ dailyLimit: Number(e.target.value) })}
                      />
                    </Field>
                  </div>
                  <ScheduleEditor
                    label="Profile refresh"
                    schedule={draft.profileSchedule}
                    onChange={(value) => update({ profileSchedule: value })}
                  />
                  <ScheduleEditor
                    label="Job applications"
                    schedule={draft.applicationSchedule}
                    onChange={(value) => update({ applicationSchedule: value })}
                  />
                  <div className="callout">
                    <Clock3 size={17} />
                    <p>
                      Missed a schedule? Autopilot catches up once when the computer and app are
                      available again.
                    </p>
                  </div>
                </section>
                <section className="panel padded">
                  <div className="section-heading">
                    <div className="section-icon purple">
                      <CheckCheck size={21} />
                    </div>
                    <div>
                      <h2>Answers, in your own words</h2>
                      <p>Used only for clearly recognized questions with matching units.</p>
                    </div>
                  </div>
                  <div className="form-grid">
                    {(
                      [
                        { key: 'totalExperience', label: 'Total experience (years)' },
                        { key: 'currentCtc', label: 'Current CTC (₹ LPA)' },
                        { key: 'expectedCtc', label: 'Expected CTC (₹ LPA)' },
                        { key: 'noticePeriodDays', label: 'Notice period (days)' },
                      ] as const
                    ).map((field) => (
                      <Field label={field.label} key={field.key}>
                        <input
                          type="number"
                          min="0"
                          step={field.key === 'noticePeriodDays' ? '1' : '0.5'}
                          value={draft.candidate[field.key] ?? ''}
                          onChange={(e) =>
                            update({
                              candidate: {
                                ...draft.candidate,
                                [field.key]: e.target.value === '' ? null : Number(e.target.value),
                              },
                            })
                          }
                        />
                      </Field>
                    ))}
                    <Field label="Current location">
                      <input
                        value={draft.candidate.currentLocation}
                        onChange={(e) =>
                          update({
                            candidate: { ...draft.candidate, currentLocation: e.target.value },
                          })
                        }
                      />
                    </Field>
                  </div>
                  <h3 className="saved-answers-heading">
                    Saved screening answers <span>{draft.answers.length}</span>
                  </h3>
                  {draft.answers.length ? (
                    draft.answers.map((answer) => (
                      <div className="saved-answer" key={answer.id}>
                        <div>
                          <strong>{answer.question}</strong>
                          <p>{answer.answer}</p>
                        </div>
                        <button
                          aria-label={`Delete answer: ${answer.question}`}
                          className="icon-button"
                          onClick={() =>
                            update({ answers: draft.answers.filter((a) => a.id !== answer.id) })
                          }
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    ))
                  ) : (
                    <p className="muted">
                      Unfamiliar questions appear in Jobs → Needs attention. Save an answer there to
                      use it on a later run.
                    </p>
                  )}
                </section>
                <section className="panel padded">
                  <div className="section-heading">
                    <div className="section-icon amber">
                      <Monitor size={21} />
                    </div>
                    <div>
                      <h2>At home on your computer</h2>
                      <p>No app account. No cloud workspace. No telemetry.</p>
                    </div>
                  </div>
                  <Toggle
                    label="Launch at Windows login"
                    hint="Start quietly in the tray when you sign in."
                    checked={draft.launchAtLogin}
                    onChange={(value) => update({ launchAtLogin: value })}
                  />
                  <Toggle
                    label="Run the browser in the background"
                    hint="Login and account challenges still use a visible Chrome window."
                    checked={draft.backgroundBrowser}
                    onChange={(value) => update({ backgroundBrowser: value })}
                  />
                  <Field label="Keep screenshots for (days)">
                    <input
                      type="number"
                      min="1"
                      max="365"
                      value={draft.screenshotRetentionDays}
                      onChange={(e) => update({ screenshotRetentionDays: Number(e.target.value) })}
                    />
                  </Field>
                  <div className="data-location">
                    <FolderOpen size={19} />
                    <div>
                      <strong>Your local data folder</strong>
                      <code>{snapshot.dataDirectory}</code>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => act(() => window.autopilot.openDataFolder())}
                    >
                      Open <ArrowUpRight size={14} />
                    </button>
                  </div>
                </section>
                <div className="settings-save">
                  <span>
                    {dirty
                      ? 'Changes are saved only on this device.'
                      : 'Your settings are up to date.'}
                  </span>
                  <Button variant="primary" onClick={save} disabled={!dirty || busy}>
                    <Check size={16} />
                    Save all settings
                  </Button>
                </div>
              </div>
              <aside className="settings-aside">
                <div className="tip-card">
                  <ShieldCheck size={22} />
                  <h3>You set the boundaries.</h3>
                  <p>Applications run automatically inside your filters and daily limit.</p>
                  <p>
                    Unknown answers, missing requirements, and external career sites go to your
                    attention queue.
                  </p>
                  <p>Autopilot never guesses your experience or qualifications.</p>
                </div>
              </aside>
            </div>
          )}
          <footer>
            <span>
              <ShieldCheck size={13} />
              Built for your next chapter. Kept on your computer.
            </span>
            <span>
              Naukri Autopilot <span className="version">v0.1</span>
            </span>
          </footer>
        </main>
      </div>
      {selectedRun && (
        <div className="modal-backdrop" onClick={() => setSelectedRun(null)}>
          <section
            className="modal run-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Run details"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="small-label">RUN DETAILS</span>
                <h2>{workflowLabel(selectedRun.workflow)}</h2>
              </div>
              <button
                aria-label="Close details"
                className="icon-button"
                onClick={() => setSelectedRun(null)}
              >
                <X size={21} />
              </button>
            </div>
            <div className="run-summary">
              <Badge status={selectedRun.status} />
              <span>{when(selectedRun.startedAt, settings.timezone)}</span>
            </div>
            <p>{selectedRun.message}</p>
            {selectedRun.steps.map((step) => (
              <div className="run-step" key={step.name}>
                <Badge status={step.status} />
                <div>
                  <strong>{step.name}</strong>
                  <p>{step.message}</p>
                </div>
              </div>
            ))}
            {selectedRun.workflow !== 'connect' && (
              <div className="run-counts">
                <span>
                  <strong>{selectedRun.inspected}</strong> jobs inspected
                </span>
                <span>
                  <strong>{selectedRun.submitted}</strong> applications confirmed
                </span>
              </div>
            )}
            {image ? (
              <img
                className="run-screenshot"
                src={image}
                alt="Browser screenshot captured at the end of this run"
              />
            ) : (
              <div className="evidence-empty">
                <FileText size={25} />
                <p>
                  {selectedRun.screenshotId
                    ? 'Loading screenshot…'
                    : selectedRun.evidenceNote || 'Evidence will appear when this run finishes.'}
                </p>
              </div>
            )}
          </section>
        </div>
      )}
      {answerJob?.question && (
        <div className="modal-backdrop" onClick={() => setAnswerJob(null)}>
          <section
            className="modal answer-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Save screening answer"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="small-label">SCREENING ANSWER</span>
                <h2>Let’s make the next run easier.</h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close answer"
                onClick={() => setAnswerJob(null)}
              >
                <X size={20} />
              </button>
            </div>
            <p>This answer is reused only for the same question, input type, and options.</p>
            <Field label={answerJob.question.question}>
              {answerJob.question.type === 'text' ? (
                <textarea
                  rows={3}
                  value={answerValue}
                  onChange={(e) => setAnswerValue(e.target.value)}
                />
              ) : (
                <select value={answerValue} onChange={(e) => setAnswerValue(e.target.value)}>
                  <option value="">Choose an answer</option>
                  {answerJob.question.options.map((option) => (
                    <option key={option}>{option}</option>
                  ))}
                </select>
              )}
            </Field>
            <div className="form-footer">
              <Button
                variant="primary"
                disabled={!answerValue.trim() || busy}
                onClick={() =>
                  act(async () => {
                    const q = answerJob.question!
                    const updated = {
                      ...draft,
                      answers: [
                        ...draft.answers.filter(
                          (a) =>
                            !(
                              a.question === q.question &&
                              a.type === q.type &&
                              JSON.stringify(a.options) === JSON.stringify(q.options)
                            ),
                        ),
                        { id: crypto.randomUUID(), ...q, answer: answerValue.trim() },
                      ],
                    }
                    await window.autopilot.saveSettings(updated)
                    setDraft(updated)
                    setAnswerJob(null)
                  }, 'Answer saved. The job will be rechecked on a future application run.')
                }
              >
                <Check size={15} />
                Save answer
              </Button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

function ScheduleEditor({
  label,
  schedule,
  onChange,
}: {
  label: string
  schedule: Schedule
  onChange: (value: Schedule) => void
}) {
  return (
    <div className="schedule-editor">
      <Toggle
        label={label}
        checked={schedule.enabled}
        onChange={(value) => onChange({ ...schedule, enabled: value })}
      />
      <div className="schedule-controls">
        <label>
          <Clock3 size={15} />
          <input
            aria-label={`${label} time`}
            type="time"
            value={schedule.time}
            onChange={(e) => onChange({ ...schedule, time: e.target.value })}
          />
        </label>
        <div className="weekdays">
          {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => (
            <button
              key={index}
              aria-label={`${label} ${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][index]}`}
              aria-pressed={schedule.days.includes(index + 1)}
              className={schedule.days.includes(index + 1) ? 'selected-day' : ''}
              onClick={() =>
                onChange({
                  ...schedule,
                  days: schedule.days.includes(index + 1)
                    ? schedule.days.filter((d) => d !== index + 1)
                    : [...schedule.days, index + 1].sort(),
                })
              }
            >
              {day}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
