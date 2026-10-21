export type Outcome = 'open' | 'fixed' | 'not_an_issue' | 'answered' | 'skipped'
export type Question = {
  path: string
  line: number
  question: string
  outcome: Outcome
  note: string
  hunk: string
  isTouched: boolean
}
export type Round = { sha: string; base: string; reviewedAt: number; questions: Question[]; postedUrl: string }
export type Board = {
  key: string
  target: string
  rounds: Round[]
  commitsSince: number
  expanded: number[]
  isShowingEarlier: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'socrates': { board: Board }
  }
}
