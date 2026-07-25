import test from 'node:test'
import assert from 'node:assert/strict'
import { bigFromSchema, byLabel, callsLabelled, emptyFromSchema, firstIndexOf, run, scopingReturns } from './helpers.js'

const CONTROLS = [
  { id: 'CC6.1', name: 'Logical access controls' },
  { id: 'CC6.6', name: 'Encryption in transit' },
  { id: 'CC7.2', name: 'Security event logging' },
  { id: 'CC8.1', name: 'Change management' },
  { id: 'A1.2', name: 'Backup and recovery' },
]

// ── control-evidence-sweep ─────────────────────────────────────────────────

test('control-evidence-sweep: one investigator per control, each told which control it owns', async () => {
  const { transcript } = await run('control-evidence-sweep', { args: { controls: CONTROLS } })
  const investigators = callsLabelled(transcript, 'investigate:')

  assert.strictEqual(investigators.length, CONTROLS.length)
  for (const control of CONTROLS) {
    const own = investigators.filter((call) => call.label === `investigate:${control.id}`)
    assert.strictEqual(own.length, 1, `expected exactly one investigator for ${control.id}`)
    assert.ok(own[0].prompt.includes(control.id), `${control.id} investigator prompt must name its control`)
  }
})

test('control-evidence-sweep: every claimed evidence item gets its own challenger', async () => {
  const { transcript } = await run('control-evidence-sweep', { args: { controls: CONTROLS } })
  const investigators = callsLabelled(transcript, 'investigate:')
  const challengers = callsLabelled(transcript, 'challenge:')

  // The default stub returns one claim per investigation.
  assert.strictEqual(challengers.length, investigators.length)

  for (const control of CONTROLS) {
    const investigation = investigators.find((c) => c.label === `investigate:${control.id}`)
    const challenge = challengers.find((c) => c.label === `challenge:${control.id}`)
    assert.ok(challenge, `expected a challenger for ${control.id}`)
    assert.notStrictEqual(
      challenge.prompt,
      investigation.prompt,
      'the challenger must be given a different brief, or it is not an independent check',
    )
    assert.ok(/break it|knock|refut/i.test(challenge.prompt), 'the challenger brief must be adversarial')
  }
})

test('control-evidence-sweep: a refuted claim becomes a gap and keeps its refutation', async () => {
  const { result } = await run('control-evidence-sweep', {
    args: { controls: CONTROLS },
    respond: byLabel({
      'challenge:': { verdict: 'refuted', reason: 'The config is overridden in production.' },
    }),
  })

  assert.strictEqual(result.coverage.satisfied, 0)
  assert.strictEqual(result.coverage.gaps, CONTROLS.length)
  assert.strictEqual(result.satisfied.length, 0)
  for (const gap of result.gaps) {
    assert.ok(gap.refutedClaims.length > 0, `${gap.id} must retain the refuted claim, not drop it`)
    assert.match(gap.refutedClaims[0].reason, /overridden in production/)
  }
})

test('control-evidence-sweep: an unverifiable claim is counted apart from satisfied', async () => {
  const { result } = await run('control-evidence-sweep', {
    args: { controls: CONTROLS },
    respond: byLabel({
      'challenge:': { verdict: 'unverified', reason: 'The deployment config was not readable.' },
    }),
  })

  assert.strictEqual(result.coverage.satisfied, 0, 'unverified must never be reported as satisfied')
  assert.strictEqual(result.coverage.unverified, CONTROLS.length)
  assert.strictEqual(result.coverage.gaps, 0)
})

test('control-evidence-sweep: a confirmed claim satisfies its control', async () => {
  const { result } = await run('control-evidence-sweep', {
    args: { controls: CONTROLS },
    respond: byLabel({ 'challenge:': { verdict: 'confirmed', reason: 'Verified in the Terraform module.' } }),
  })

  assert.strictEqual(result.coverage.satisfied, CONTROLS.length)
  assert.strictEqual(result.coverage.gaps, 0)
})

test('control-evidence-sweep: falls back to the built-in SOC 2 catalogue and says so', async () => {
  const { result, transcript } = await run('control-evidence-sweep')

  assert.match(result.catalogue, /SOC 2/)
  assert.ok(result.controlCount >= 5, 'the built-in starter set must be substantive')
  assert.strictEqual(callsLabelled(transcript, 'investigate:').length, result.controlCount)
})

test('control-evidence-sweep: an empty control list is an empty scope, not a clean bill of health', async () => {
  const { result } = await run('control-evidence-sweep', { args: { controls: [] } })

  assert.strictEqual(result.emptyScope, true)
  assert.strictEqual(result.satisfied.length, 0)
})

// ── reg-change-impact ──────────────────────────────────────────────────────

test('reg-change-impact: obligations are decomposed before any service is assessed', async () => {
  const { result, transcript } = await run('reg-change-impact', {
    args: { regime: 'DORA', change: 'ICT incident reporting within 4 hours' },
  })

  const decompose = firstIndexOf(transcript, 'decompose-obligations')
  const firstAssess = firstIndexOf(transcript, 'assess:')

  assert.strictEqual(decompose, 0, 'decomposition is the first thing that happens')
  assert.ok(firstAssess > decompose, 'no service may be assessed before the obligations exist')
  assert.ok(Array.isArray(result.obligations) && result.obligations.length > 0, 'the obligation list is part of the deliverable')
})

test('reg-change-impact: the assessment fan-out is capped and the truncation is reported', async () => {
  const oversized = byLabel({ 'scope-affected-services': (call) => bigFromSchema(call.schema, 200) })

  const wide = await run('reg-change-impact', { respond: oversized })
  assert.strictEqual(callsLabelled(wide.transcript, 'assess:').length, 60, 'default cap is 60 assessments')
  assert.strictEqual(wide.result.candidatesConsidered, 200)
  assert.strictEqual(wide.result.truncated, 140, 'the operator must be told what was left unassessed')

  const narrow = await run('reg-change-impact', { args: { maxAssessments: 10 }, respond: oversized })
  assert.strictEqual(callsLabelled(narrow.transcript, 'assess:').length, 10)
  assert.strictEqual(narrow.result.truncated, 190)
})

test('reg-change-impact: every impacted item is staffable', async () => {
  const { result } = await run('reg-change-impact')

  assert.ok(result.impacted.length > 0)
  for (const item of result.impacted) {
    for (const field of ['service', 'severity', 'effort', 'obligation']) {
      assert.ok(
        typeof item[field] === 'string' && item[field].length > 0,
        `impacted item is missing "${field}" — it cannot be put on a board`,
      )
    }
  }
})

test('reg-change-impact: compliant and not-applicable services leave the backlog', async () => {
  const { result } = await run('reg-change-impact', {
    respond: byLabel({ 'assess:': { status: 'met', severity: 'low', effort: 'xs', evidence: ['already enforced'] } }),
  })

  assert.strictEqual(result.impacted.length, 0)
  assert.strictEqual(result.backlog.length, 0)
  assert.ok(result.outOfScope.length > 0, 'services that were checked and cleared must still be reported')
})

test('reg-change-impact: a change with no engineering obligations is an empty scope', async () => {
  const { result } = await run('reg-change-impact', { respond: scopingReturns(emptyFromSchema) })

  assert.strictEqual(result.emptyScope, true)
  assert.match(result.reason, /obligation/i)
})
