import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Outcome, Question, Round } from '../types'

const PANE = 'socrates-board'
const MAX_QUESTIONS = 5
const MAX_HUNK_CHARS = 4000
const HEAD_POLL_MS = 30_000
const EDITING_TOOLS = new Set(['Edit', 'Write'])
const OUTCOMES: readonly Outcome[] = ['open', 'fixed', 'not_an_issue', 'answered', 'skipped']
const GLYPH: Record<Outcome, string> = { open: '?', fixed: '✓', not_an_issue: '–', answered: '✓', skipped: '↷' }
const LABEL: Record<Outcome, string> = {
  open: 'open',
  fixed: 'fixed',
  not_an_issue: 'not an issue',
  answered: 'answered',
  skipped: 'skipped',
}
const EMPTY_BOARD: Board = { key: '', target: '', rounds: [], commitsSince: 0, expanded: [], isShowingEarlier: false }

const board = atom({ plugin: 'socrates', key: 'board' } as const, EMPTY_BOARD)

const text = (raw: unknown) => (typeof raw === 'string' ? raw.trim() : '')

const git = async ($: EngineInterface, args: string[], cwd?: string) => {
  const run = await $.process.run(['git', ...args], cwd ? { cwd } : undefined).catch(() => null)
  return run?.exitCode === 0 ? run.stdout.trim() : ''
}

const worktreeFor = async ($: EngineInterface, branch: string) => {
  const listing = await git($, ['worktree', 'list', '--porcelain'])
  const entry = listing
    .split('\n\n')
    .find(block => block.split('\n').includes(`branch refs/heads/${branch}`))
  return entry?.split('\n').find(row => row.startsWith('worktree '))?.slice('worktree '.length)
}

const currentBranch = ($: EngineInterface) => git($, ['rev-parse', '--abbrev-ref', 'HEAD'])

const boardKey = async ($: EngineInterface, target: string) => {
  const commonDir = await git($, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  return `${commonDir.replace(/\/\.git$/, '')}::${target}`
}

const defaultBase = async ($: EngineInterface, sha = 'HEAD', cwd?: string) => {
  const remoteHead = (await git($, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd)) || 'origin/main'
  return git($, ['merge-base', sha, remoteHead], cwd)
}

const isSameCommit = async ($: EngineInterface, a: string, b: string, cwd?: string) => {
  if (!a || !b) return false
  const [ra, rb] = await Promise.all([git($, ['rev-parse', a], cwd), git($, ['rev-parse', b], cwd)])
  return ra !== '' && ra === rb
}

const resolveBase = async ($: EngineInterface, given: string, sha: string, cwd?: string) =>
  given && !(await isSameCommit($, given, sha || 'HEAD', cwd)) ? given : defaultBase($, sha || 'HEAD', cwd)

const hunkAt = (diff: string, line: number) => {
  const hunks = diff.split(/\n(?=@@ )/).filter(h => h.startsWith('@@ '))
  const covering = hunks.find(h => {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(h)
    if (!match) return false
    const start = Number(match[1])
    const length = match[2] === undefined ? 1 : Number(match[2])
    return line >= start && line < start + Math.max(length, 1)
  })
  return (covering ?? '').slice(0, MAX_HUNK_CHARS)
}

const GH_CANDIDATES = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']

const prDiff = async ($: EngineInterface, target: string) => {
  const selector = /^#?(\d+)$/.exec(target)?.[1] ?? target
  if (!selector) return ''
  for (const gh of GH_CANDIDATES) {
    const run = await $.process.run([gh, 'pr', 'diff', selector], { timeoutMs: 60_000 }).catch(() => null)
    if (run?.exitCode === 0) return run.stdout
  }
  return ''
}

const fileSection = (diff: string, path: string) =>
  diff.split(/\n(?=diff --git )/).find(section => section.startsWith(`diff --git a/${path} `) || section.includes(` b/${path}\n`)) ?? ''

const findHunk = async (
  $: EngineInterface,
  { target, base, sha, path, line }: { target: string; base: string; sha: string; path: string; line: number },
  pullDiff?: string,
) => {
  if (!path) return ''
  const cwd = await worktreeFor($, target)
  const realBase = await resolveBase($, base, sha, cwd)
  if (realBase) {
    const fromCommits = hunkAt(await git($, ['diff', '-U3', realBase, sha || 'HEAD', '--', path], cwd), line)
    if (fromCommits) return fromCommits
    const withUncommitted = hunkAt(await git($, ['diff', '-U3', realBase, '--', path], cwd), line)
    if (withUncommitted) return withUncommitted
  }
  return hunkAt(fileSection(pullDiff ?? (await prDiff($, target)), path), line)
}

const toQuestions = async (
  $: EngineInterface,
  raw: unknown,
  { target, base, sha }: { target: string; base: string; sha: string },
): Promise<Question[]> => {
  const items = (Array.isArray(raw) ? raw.slice(0, MAX_QUESTIONS) : []).filter(item => text(item?.question))
  const needsPull = /^#?\d+$/.test(target) || !(await worktreeFor($, target))
  const pullDiff = needsPull ? await prDiff($, target) : ''
  return Promise.all(
    items.map(async item => {
      const path = text(item?.path)
      const line = Number(item?.line) || 0
      const hunk = await findHunk($, { target, base, sha, path, line }, pullDiff)
      return { path, line, question: text(item?.question), outcome: 'open' as const, note: '', hunk, isTouched: false }
    }),
  )
}

const fillMissingHunk = async ($: EngineInterface, index: number) => {
  const current = await read($, board)
  const round = latest(current)
  const q = round?.questions[index]
  if (!round || !q || q.hunk) return
  const hunk = await findHunk($, { target: current.target, base: round.base, sha: round.sha, path: q.path, line: q.line })
  if (!hunk) return
  await save($, b => ({
    ...b,
    rounds: b.rounds.map((r, ri) =>
      ri === b.rounds.length - 1 ? { ...r, questions: r.questions.map((x, qi) => (qi === index ? { ...x, hunk } : x)) } : r,
    ),
  }))
}

const latest = (b: Board): Round | undefined => b.rounds[b.rounds.length - 1]
const openCount = (b: Board) => latest(b)?.questions.filter(q => q.outcome === 'open').length ?? 0
const anchor = (q: Question) => (q.line > 0 ? `${q.path}:${q.line}` : q.path)

const showStatus = ($: EngineInterface, b: Board) => {
  const open = openCount(b)
  $.ui.status(open > 0 ? `🏛️ ${open} open` : undefined)
}

const save = async ($: EngineInterface, change: (b: Board) => Board) => {
  await update($, board, change)
  const next = await read($, board)
  if (next.key) await $.store.set(next.key, next)
  showStatus($, next)
  return next
}

const refreshStaleness = async ($: EngineInterface) => {
  const current = await read($, board)
  const round = latest(current)
  if (!round?.sha) return
  const cwd = await worktreeFor($, current.target)
  if (!cwd && current.target !== (await currentBranch($))) return
  const count = Number(await git($, ['rev-list', '--count', `${round.sha}..HEAD`], cwd)) || 0
  if (count !== current.commitsSince) await save($, b => ({ ...b, commitsSince: count }))
}

const loadBranchBoard = async ($: EngineInterface) => {
  const branch = await currentBranch($)
  if (!branch) return
  const key = await boardKey($, branch)
  const stored = (await $.store.get(key)) as Board | undefined
  if (!stored?.rounds?.length) return
  await update($, board, () => ({ ...EMPTY_BOARD, ...stored, key }))
  showStatus($, stored)
  await refreshStaleness($)
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: '🏛️ Socrates' })

const setOutcome = ($: EngineInterface, index: number, outcome: Outcome, note: string) =>
  save($, b => ({
    ...b,
    rounds: b.rounds.map((r, ri) =>
      ri === b.rounds.length - 1
        ? { ...r, questions: r.questions.map((q, qi) => (qi === index ? { ...q, outcome, note } : q)) }
        : r,
    ),
  }))

const toggle = (list: number[], value: number) =>
  list.includes(value) ? list.filter(v => v !== value) : [...list, value]

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'set_questions',
      description:
        'Show a Socrates review in the Socrates pane beside the chat. Call it once per Socrates review, right after deciding the questions (also when there are none), with the target (PR number like "#123", or the branch name), the short head SHA, the base commit the diff was taken against, and up to 5 questions ranked most important first, each anchored to a diff line. A review of the same target is added as its next round. The result says whether the pane is on screen and so how much of the review to print in chat.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'PR number like "#123", or the branch name' },
          sha: { type: 'string', description: 'Short head SHA reviewed' },
          base: {
            type: 'string',
            description: 'The merge-base commit the diff was taken against (never the head SHA); omit if unsure',
          },
          questions: {
            type: 'array',
            maxItems: MAX_QUESTIONS,
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, line: { type: 'number' }, question: { type: 'string' } },
              required: ['path', 'line', 'question'],
            },
          },
        },
        required: ['target', 'sha', 'questions'],
      },
    })
    await $.tool.register({
      name: 'resolve_question',
      description:
        'Record how one question of the latest Socrates round was settled: its 1-based number, the outcome (fixed: the code changed; not_an_issue: it holds as written; answered: the person answered it well in their own words; skipped; open: reopen or still open) and a one-line note saying why. When judging the person\'s own answer leaves a gap, keep it open and name the gap in the note.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          number: { type: 'number' },
          outcome: { type: 'string', enum: OUTCOMES },
          note: { type: 'string' },
        },
        required: ['number', 'outcome', 'note'],
      },
    })
    await $.tool.register({
      name: 'mark_posted',
      description: 'Record that the latest Socrates round was posted as a GitHub review, with the review URL.',
      isDeferred: false,
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    })
    await $.command.register({ name: 'socrates-board', description: 'Show the Socrates pane' })
    await loadBranchBoard($)
    $.clock.every(HEAD_POLL_MS, () => void refreshStaleness($))
    if (openCount(await read($, board)) > 0) void openPane($)
    return started
  })

  on('command.run', { command: 'socrates-board' }, async $ => {
    await openPane($)
    return { text: 'Socrates pane opened.' }
  })

  on('tool.call', { tool: 'mcp__socrates__set_questions' }, async ($, e) => {
    const target = text(e.target)
    const sha = text(e.sha)
    const base = text(e.base)
    const key = await boardKey($, target)
    const questions = await toQuestions($, e.questions, { target, base, sha })
    const round: Round = { sha, base, reviewedAt: await $.clock.now(), questions, postedUrl: '' }

    const current = await read($, board)
    const existing = current.key === key ? current : ((await $.store.get(key)) as Board | undefined)
    const previous = existing?.rounds ?? []
    const last = previous[previous.length - 1]
    const isRepeat =
      last?.sha === sha && last.questions.map(q => q.question).join('\n') === questions.map(q => q.question).join('\n')
    const rounds = isRepeat ? [...previous.slice(0, -1), { ...round, questions: last.questions.map((q, i) => ({ ...q, hunk: questions[i]?.hunk || q.hunk })) }] : [...previous, round]
    await save($, () => ({ ...EMPTY_BOARD, key, target, rounds }))
    await refreshStaleness($)

    $.ui.toast(`🏛️ Socrates: ${questions.length || 'no'} question${questions.length === 1 ? '' : 's'} on ${target}`)
    const { isPlaced } = await openPane($)
    return {
      result: isPlaced
        ? `Round ${rounds.length} is on screen in the Socrates pane. In chat, print only the header line and the question count, not the questions.`
        : `Round ${rounds.length} is saved, but the Socrates pane is not on screen. Print the full review in chat.`,
    }
  })

  on('tool.call', { tool: 'mcp__socrates__resolve_question' }, async ($, e) => {
    const index = Number(e.number) - 1
    const outcome = OUTCOMES.includes(e.outcome as Outcome) ? (e.outcome as Outcome) : 'open'
    if (!latest(await read($, board))?.questions[index]) {
      return { deny: `There is no question ${e.number} in the latest Socrates round.` }
    }
    await setOutcome($, index, outcome, text(e.note))
    return { result: `Question ${index + 1} marked ${LABEL[outcome]}.` }
  })

  on('tool.call', { tool: 'mcp__socrates__mark_posted' }, async ($, e) => {
    if (!latest(await read($, board))) return { deny: 'There is no Socrates round to mark as posted.' }
    await save($, b => ({
      ...b,
      rounds: b.rounds.map((r, i) => (i === b.rounds.length - 1 ? { ...r, postedUrl: text(e.url) } : r)),
    }))
    return { result: 'Marked as posted.' }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (e.tool === 'Bash') void refreshStaleness($).catch(() => undefined)
    const filePath = EDITING_TOOLS.has(e.tool) ? text((e as { file_path?: unknown }).file_path) : ''
    if (filePath) {
      void save($, b => ({
        ...b,
        rounds: b.rounds.map((r, i) =>
          i === b.rounds.length - 1
            ? {
                ...r,
                questions: r.questions.map(q =>
                  q.outcome === 'open' && q.path && filePath.endsWith(`/${q.path}`) ? { ...q, isTouched: true } : q,
                ),
              }
            : r,
        ),
      })).catch(() => undefined)
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const current = await read($, board)
    const round = latest(current)

    if (!round) return <Text dimColor>No Socrates review yet. Ask for one with “socrates this branch”.</Text>

    const { questions } = round
    const settled = questions.length - openCount(current)
    const earlier = current.rounds.slice(0, -1)

    const address = (q: Question, n: number) =>
      $.prompt.fill({ text: `Address Socrates question ${n} (${anchor(q)}): ${q.question}` })
    const answerMyself = (q: Question, n: number) =>
      $.prompt.fill({ text: `My answer to Socrates question ${n} (${anchor(q)}): ` })
    const skip = (n: number) => setOutcome($, n - 1, 'skipped', 'set aside')
    const reopen = (n: number) => setOutcome($, n - 1, 'open', '')
    const toggleCode = async (i: number) => {
      await update($, board, b => ({ ...b, expanded: toggle(b.expanded, i) }))
      if ((await read($, board)).expanded.includes(i)) await fillMissingHunk($, i)
    }
    const toggleEarlier = () => update($, board, b => ({ ...b, isShowingEarlier: !b.isShowingEarlier }))
    const addressAll = () => $.prompt.submit({ text: 'Address the open Socrates questions.' })
    const reReview = () =>
      $.prompt.submit({ text: `Socrates this branch again, reviewing only the changes since ${round.sha}.` })
    const post = () => $.prompt.submit({ text: 'Post the latest Socrates round to the PR.' })
    const clear = async () => {
      if (current.key) await $.store.delete(current.key)
      await update($, board, () => EMPTY_BOARD)
      $.ui.status(undefined)
    }

    return (
      <Box flexDirection="column">
        <Text bold>
          {current.target} <Text dimColor>@ {round.sha}</Text>
          {current.rounds.length > 1 && <Text dimColor> · round {current.rounds.length}</Text>}
        </Text>
        <Text dimColor>{questions.length === 0 ? 'No questions.' : `${settled}/${questions.length} settled`}</Text>
        {round.postedUrl && <Text color="success">posted ↗ {round.postedUrl}</Text>}
        {current.commitsSince > 0 && (
          <Box flexDirection="row">
            <Text color="warning">
              stale: {current.commitsSince} commit{current.commitsSince === 1 ? '' : 's'} since {round.sha}{' '}
            </Text>
            <Button key="rereview" hotkey="r" onPress={reReview}>
              Re-review
            </Button>
          </Box>
        )}

        {questions.map((q, i) => {
          const n = i + 1
          const isOpen = q.outcome === 'open'
          const isExpanded = current.expanded.includes(i)
          return (
            <Box key={`q${i}`} flexDirection="column" marginTop={1}>
              <Button key={`toggle${i}`} hotkey={String(n)} plain dimColor onPress={() => toggleCode(i)}>
                {isExpanded ? '▾' : '▸'} {n}. {anchor(q)}
                {q.isTouched && <Text color="warning"> · touched</Text>}
              </Button>
              <Text
                color={q.outcome === 'fixed' || q.outcome === 'answered' ? 'success' : undefined}
                dimColor={q.outcome === 'not_an_issue' || q.outcome === 'skipped'}
                bold={isOpen}
              >
                {GLYPH[q.outcome]} {q.question}
              </Text>
              {!isOpen && (
                <Text dimColor>
                  {LABEL[q.outcome]}
                  {q.note ? `: ${q.note}` : ''}
                </Text>
              )}
              {isOpen && q.note && <Text color="warning">gap: {q.note}</Text>}
              {isExpanded && q.hunk && <Code source={q.hunk} path={q.path} format="diff" wrap="truncate-end" />}
              {isExpanded && !q.hunk && <Text dimColor>No diff hunk found at this line.</Text>}
              {isOpen && (
                <Box flexDirection="row" columnGap={2}>
                  <Button key={`address${i}`} plain dimColor onPress={() => address(q, n)}>
                    Address
                  </Button>
                  <Button key={`answer${i}`} plain dimColor onPress={() => answerMyself(q, n)}>
                    I'll answer
                  </Button>
                  <Button key={`skip${i}`} plain dimColor onPress={() => skip(n)}>
                    Skip
                  </Button>
                </Box>
              )}
              {!isOpen && (
                <Box flexDirection="row">
                  <Button key={`reopen${i}`} plain dimColor onPress={() => reopen(n)}>
                    Reopen
                  </Button>
                </Box>
              )}
            </Box>
          )
        })}

        {earlier.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Button key="earlier" hotkey="e" plain dimColor onPress={toggleEarlier}>
              {current.isShowingEarlier ? '▾' : '▸'} {earlier.length} earlier round{earlier.length === 1 ? '' : 's'}
            </Button>
            {current.isShowingEarlier &&
              earlier.map((r, ri) => (
                <Text dimColor>
                  round {ri + 1} @ {r.sha}: {r.questions.filter(q => q.outcome !== 'open').length}/{r.questions.length}{' '}
                  settled{r.postedUrl ? ' · posted' : ''}
                </Text>
              ))}
          </Box>
        )}

        <Box marginTop={1} flexDirection="row" columnGap={1}>
          {settled < questions.length && (
            <Button key="all" hotkey="a" onPress={addressAll}>
              Address all
            </Button>
          )}
          {!round.postedUrl && questions.length > 0 && (
            <Button key="post" hotkey="p" dimColor onPress={post}>
              Post to PR
            </Button>
          )}
          <Button key="clear" hotkey="c" dimColor onPress={clear}>
            Clear
          </Button>
        </Box>
      </Box>
    )
  })
}
