import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'socrates',
  component: 'Pane',
  requestId: 'socrates-board',
  props: {
    title: '🏛️ Socrates',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const start = async ($: any, on: any) => {
  on('command.register', () => ({ value: { command: 'socrates-board' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__socrates__set_questions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  const stored = new Map<string, unknown>()
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('store.get', (_: unknown, e: { key: string }) => ({ value: stored.get(e.key) }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => (stored.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_: unknown, e: { key: string }) => (stored.delete(e.key), { value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  return $.tool.call({
    tool: 'mcp__socrates__set_questions',
    target: 'feature-sessions',
    sha: 'd8ff337',
    base: 'abc1234',
    questions: [
      { path: 'api/src/session.ts', line: 42, question: 'What happens when the cookie is missing?' },
      { path: 'api/src/session.ts', line: 88, question: 'Which caller relies on this returning null?' },
    ],
  })
}

test('lists each question under its anchor', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /settled/ }))?.text).toBe('0/2 settled')
  expect((await ui.find({ type: 'Text', text: /cookie/ }))?.text).toBe('? What happens when the cookie is missing?')
  await ui.unmount()
})

test('tells the model to keep chat short when the pane is on screen', async ($, on) => {
  const { result } = await start($, on)
  expect(String(result)).toContain('print only the header line')
})

test('shows the outcome and note once a question is answered', async ($, on) => {
  await start($, on)
  await $.tool.call({
    tool: 'mcp__socrates__resolve_question',
    number: 1,
    outcome: 'answered',
    note: 'falls back to an anonymous session',
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /settled/ }))?.text).toBe('1/2 settled')
  expect((await ui.find({ type: 'Text', text: /falls back/ }))?.text).toBe('answered: falls back to an anonymous session')
  await ui.unmount()
})

test('shows the gap on a question left open after the person answers', async ($, on) => {
  await start($, on)
  await $.tool.call({
    tool: 'mcp__socrates__resolve_question',
    number: 2,
    outcome: 'open',
    note: 'the webhook caller was not covered',
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /gap/ }))?.text).toBe('gap: the webhook caller was not covered')
  await ui.unmount()
})

test('flags an open question as touched when its file is edited', async ($, on) => {
  await start($, on)
  await $.tool.call({
    tool: 'Edit',
    file_path: '/repo/api/src/session.ts',
    old_string: 'a',
    new_string: 'b',
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /touched/ })).toBeTruthy()
  await ui.unmount()
})

test('shows the posted link once the round is posted', async ($, on) => {
  await start($, on)
  await $.tool.call({ tool: 'mcp__socrates__mark_posted', url: 'https://github.com/o/r/pull/1#review-9' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /posted/ }))?.text).toBe('posted ↗ https://github.com/o/r/pull/1#review-9')
  await ui.unmount()
})

test('adds a second review of the same target as round 2', async ($, on) => {
  await start($, on)
  await $.tool.call({
    tool: 'mcp__socrates__set_questions',
    target: 'feature-sessions',
    sha: 'e9aa001',
    base: 'd8ff337',
    questions: [{ path: 'api/src/session.ts', line: 50, question: 'Who clears this flag?' }],
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /round 2/ })).toBeTruthy()
  await ui.unmount()
})

test('shows the hunk from the PR diff when the reviewed commits are not local', async ($, on) => {
  const prDiff = [
    'diff --git a/api/src/routes/checkout.ts b/api/src/routes/checkout.ts',
    '--- a/api/src/routes/checkout.ts',
    '+++ b/api/src/routes/checkout.ts',
    '@@ -40,3 +40,4 @@ export const checkout = async () => {',
    '   const plan = await loadPlan()',
    '+  await recordReceipt(plan)',
    '   return plan',
    ' }',
    '',
  ].join('\n')
  on('command.register', () => ({ value: { command: 'socrates-board' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__socrates__set_questions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('process.run', (_: unknown, e: { argv: string[] }) =>
    e.argv[1] === 'pr' ? { value: { exitCode: 0, stdout: prDiff, stderr: '' } } : { value: { exitCode: 1, stdout: '', stderr: '' } },
  )
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__socrates__set_questions',
    target: '#123',
    sha: 'f00ba12',
    questions: [{ path: 'api/src/routes/checkout.ts', line: 41, question: 'What if the receipt write throws?' }],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'toggle0' })
  expect(await ui.find({ type: 'Code' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /No diff hunk/ })).toBeUndefined()
  await ui.unmount()
})

test('shows the hunk from uncommitted changes in the branch worktree when the base is the head', async ($, on) => {
  const worktreeDiff = [
    'diff --git a/api/src/routes/orders.ts b/api/src/routes/orders.ts',
    '@@ -370,7 +370,7 @@ const routes = () => {',
    '   const a = 1',
    '-  const b = 2',
    '+  const b = 3',
    '   const c = 4',
    '',
  ].join('\n')
  on('command.register', () => ({ value: { command: 'socrates-board' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__socrates__set_questions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('process.run', (_: unknown, e: { argv: string[]; init?: { cwd?: string } }) => {
    const args = e.argv.slice(1).join(' ')
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })
    if (args === 'worktree list --porcelain') {
      return ok('worktree /repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree /repo-orders\nHEAD 21f5c31\nbranch refs/heads/orders-refactor\n')
    }
    if (args.startsWith('rev-parse 21f5c31')) return ok('21f5c31full')
    if (args.startsWith('merge-base')) return ok('21f5c31full')
    if (args.startsWith('diff -U3 21f5c31full -- ') && e.init?.cwd === '/repo-orders') return ok(worktreeDiff)
    return { value: { exitCode: 1, stdout: '', stderr: '' } }
  })
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'mcp__socrates__set_questions',
    target: 'orders-refactor',
    sha: '21f5c31',
    base: '21f5c31',
    questions: [
      { path: 'api/src/routes/orders.ts', line: 373, question: 'Which step runs after the order is placed?' },
    ],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'toggle0' })
  expect(await ui.find({ type: 'Code' })).toBeTruthy()
  await ui.unmount()
})
