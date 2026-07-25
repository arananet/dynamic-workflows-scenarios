import test from 'node:test'
import assert from 'node:assert/strict'
import { byLabel, callsLabelled, emptyFromSchema, firstIndexOf, run, scopingReturns } from './helpers.js'

// ── ma-code-diligence ──────────────────────────────────────────────────────

test('ma-code-diligence: one agent per lens, each briefed on its own lens only', async () => {
  const { transcript, result } = await run('ma-code-diligence')
  const lenses = callsLabelled(transcript, 'lens:')

  assert.ok(lenses.length >= 6, 'the default lens set must cover the risks a deal team asks about')
  assert.strictEqual(lenses.length, result.lensesAssessed.length)
  assert.strictEqual(new Set(lenses.map((call) => call.label)).size, lenses.length, 'no lens runs twice')

  for (const call of lenses) {
    const lens = call.label.slice('lens:'.length)
    assert.ok(result.lensesAssessed.includes(lens))
    assert.ok(call.prompt.includes('Your lens, and only your lens'), 'each lens must be told to stay in its lane')
  }
})

test('ma-code-diligence: args.lenses restricts the run and unknown lenses are reported, not swallowed', async () => {
  const { transcript, result } = await run('ma-code-diligence', {
    args: { lenses: ['licensing', 'secrets', 'crystalBall'] },
  })

  assert.deepStrictEqual(
    callsLabelled(transcript, 'lens:').map((call) => call.label),
    ['lens:licensing', 'lens:secrets'],
  )
  assert.deepStrictEqual(result.skippedLenses, ['crystalBall'])
  assert.deepStrictEqual(result.lensesAssessed, ['licensing', 'secrets'])
})

test('ma-code-diligence: reconciliation happens exactly once, after every lens', async () => {
  const { transcript } = await run('ma-code-diligence')
  const reconciliations = callsLabelled(transcript, 'reconcile-memo')
  const lastLens = transcript.map((c) => c.label).lastIndexOf(
    callsLabelled(transcript, 'lens:').at(-1).label,
  )

  assert.strictEqual(reconciliations.length, 1)
  assert.ok(reconciliations[0].index > lastLens, 'the memo must see every lens before it classifies anything')
})

test('ma-code-diligence: every deal-breaker is defensible in a negotiation', async () => {
  const { result } = await run('ma-code-diligence')

  assert.ok(result.dealBreakers.length > 0)
  for (const item of result.dealBreakers) {
    for (const field of ['title', 'evidence', 'effort', 'why']) {
      assert.ok(
        typeof item[field] === 'string' && item[field].length > 0,
        `deal-breaker is missing "${field}" — it cannot be argued at a negotiating table`,
      )
    }
  }
})

test('ma-code-diligence: what each lens could not check survives into the memo', async () => {
  const { result } = await run('ma-code-diligence', {
    args: { lenses: ['licensing'] },
    respond: byLabel({ 'lens:': { score: 3, findings: [], notChecked: ['no lockfile for the vendored tree'] } }),
  })

  assert.deepStrictEqual(result.notChecked, ['licensing: no lockfile for the vendored tree'])
})

test('ma-code-diligence: an unknown-only lens set is an empty scope', async () => {
  const { result } = await run('ma-code-diligence', { args: { lenses: ['tarot'] } })

  assert.strictEqual(result.emptyScope, true)
  assert.deepStrictEqual(result.skippedLenses, ['tarot'])
})

// ── strangler-fig-plan ─────────────────────────────────────────────────────

test('strangler-fig-plan: exactly three plans, from three genuinely different angles', async () => {
  const { transcript, result } = await run('strangler-fig-plan')
  const plans = callsLabelled(transcript, 'plan:')

  assert.strictEqual(plans.length, 3)
  assert.strictEqual(new Set(plans.map((c) => c.label)).size, 3)
  assert.strictEqual(result.plans.length, 3)

  const angleNames = plans.map((call) => call.prompt.match(/Your angle: (.+)/)?.[1])
  assert.strictEqual(new Set(angleNames).size, 3, 'each drafter must be given a distinct angle')
  for (const call of plans) {
    assert.ok(call.prompt.includes('Commit to your angle'), 'a hedging drafter produces three copies of one plan')
  }
})

test('strangler-fig-plan: every plan is critiqued equally, and never by its own author', async () => {
  const { transcript, result } = await run('strangler-fig-plan')
  const critiques = callsLabelled(transcript, 'critique:')

  assert.strictEqual(critiques.length, 6, '3 plans x 2 rival angles')

  const perPlan = new Map()
  for (const call of critiques) {
    const [target, critic] = call.label.slice('critique:'.length).split('<-')
    assert.notStrictEqual(target, critic, 'a plan must never be critiqued by its own angle')
    perPlan.set(target, (perPlan.get(target) ?? 0) + 1)
  }

  assert.strictEqual(perPlan.size, 3)
  assert.deepStrictEqual([...new Set(perPlan.values())], [2], 'unequal critique counts bias the scoring')
  assert.deepStrictEqual([...new Set(result.plans.map((p) => p.critiqueCount))], [2])
})

test('strangler-fig-plan: all three scores are published and the winner is the highest', async () => {
  const scores = { 'score:domain': 61, 'score:data': 88, 'score:traffic': 45 }
  const { result } = await run('strangler-fig-plan', {
    respond: byLabel(
      Object.fromEntries(
        Object.entries(scores).map(([label, score]) => [label, { score, rationale: `scored ${score}` }]),
      ),
    ),
  })

  assert.deepStrictEqual(
    Object.fromEntries(result.plans.map((p) => [`score:${p.angle}`, p.score])),
    scores,
    'the losing plans and their scores stay attached, so the decision is auditable',
  )
  assert.strictEqual(result.selected.angle, 'data')
  assert.strictEqual(result.selected.score, 88)
  assert.deepStrictEqual(result.rejected.map((r) => r.angle).sort(), ['domain', 'traffic'])
})

test('strangler-fig-plan: scoring runs after every critique', async () => {
  const { transcript } = await run('strangler-fig-plan')
  const lastCritique = callsLabelled(transcript, 'critique:').at(-1).index
  const firstScore = firstIndexOf(transcript, 'score:')

  assert.ok(firstScore > lastCritique, 'a scorer that has not seen the objections is just re-reading the plan')
})

test('strangler-fig-plan: every roadmap step names what moves, what stays, and how to undo it', async () => {
  const { result } = await run('strangler-fig-plan')

  assert.ok(result.roadmap.length > 0)
  for (const step of result.roadmap) {
    for (const field of ['name', 'moves', 'remains', 'rollback', 'risk', 'stopTrigger']) {
      assert.ok(
        typeof step[field] === 'string' && step[field].length > 0,
        `roadmap step is missing "${field}" — a step you cannot reverse is not a step`,
      )
    }
  }
})

test('strangler-fig-plan: a system with no seams is an empty scope', async () => {
  const { result, transcript } = await run('strangler-fig-plan', { respond: scopingReturns(emptyFromSchema) })

  assert.strictEqual(result.emptyScope, true)
  assert.strictEqual(callsLabelled(transcript, 'plan:').length, 0, 'do not draft plans for a system you could not map')
})
