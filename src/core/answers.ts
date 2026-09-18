import type { CandidateFacts, SavedAnswer, ScreeningQuestion } from '../shared/types'
import { normalize } from './matching'

export function questionKey(text: string): string {
  return normalize(text)
    .replace(/[?*:]+$/g, '')
    .trim()
}
export function resolveAnswer(
  question: ScreeningQuestion,
  answers: SavedAnswer[],
  facts: CandidateFacts,
): string | null {
  const key = questionKey(question.question)
  const signature = (options: string[]) => options.map(normalize).sort().join('\u0000')
  const saved = answers.find(
    (a) =>
      questionKey(a.question) === key &&
      a.type === question.type &&
      signature(a.options) === signature(question.options),
  )
  if (saved) {
    if (question.type === 'text') return saved.answer
    return question.options.find((o) => normalize(o) === normalize(saved.answer)) ?? null
  }
  // Exact, unit-qualified mappings only. Never infer skill-specific experience or units.
  if (question.type !== 'text') return null
  const mappings: Record<string, string | number | null> = {
    'total experience (years)': facts.totalExperience,
    'total work experience in years': facts.totalExperience,
    'current ctc (in lpa)': facts.currentCtc,
    'expected ctc (in lpa)': facts.expectedCtc,
    'notice period (in days)': facts.noticePeriodDays,
    'current location': facts.currentLocation || null,
  }
  const value = mappings[key]
  return value === undefined || value === null ? null : String(value)
}
