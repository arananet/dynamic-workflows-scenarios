import test from 'node:test'
import assert from 'node:assert/strict'
import { bigFromSchema, byLabel, callsLabelled, emptyFromSchema, firstIndexOf, run, scopingReturns } from './helpers.js'

// ── cloud-cost-hotspots ────────────────────────────────────────────────────

const CLAIMED = {
  hotspots: [
    {
      pattern: 'Unbounded log retention',
      location: 'terraform/logging.tf:41',
      change: 'Set a 30-day lifecycle policy on the log bucket',
      annualLow: 12000,
      annualHigh: 18000,
      assumptions: ['4 TB/month ingested', 'standard storage class'],
      risk: 'low',
    },
  ],
}

test('cloud-cost-hotspots: surfaces are discovered before anything is swept', async () => {
  const { result, transcript } = await run('cloud-cost-hotspots')

  assert.strictEqual(firstIndexOf(transcript, 'discover-surfaces'), 0)
  assert.ok(firstIndexOf(transcript, 'sweep:') > 0)
  assert.ok(result.surfacesConsidered > 0)
  assert.strictEqual(result.surfacesSwept, callsLabelled(transcript, 'sweep:').length)
})

test('cloud-cost-hotspots: the sweep fan-out is capped and truncation is reported', async () => {
  const oversized = byLabel({ 'discover-surfaces': (call) => bigFromSchema(call.schema, 200) })

  const wide = await run('cloud-cost-hotspots', { respond: oversized })
  assert.strictEqual(callsLabelled(wide.transcript, 'sweep:').length, 80)
  assert.strictEqual(wide.result.truncated, 120)

  const narrow = await run('cloud-cost-hotspots', { args: { maxSurfaces: 5 }, respond: oversized })
  assert.strictEqual(callsLabelled(narrow.transcript, 'sweep:').length, 5)
  assert.strictEqual(narrow.result.truncated, 195)
})

test('cloud-cost-hotspots: the verifier is handed the claim it has to re-derive', async () => {
  const { transcript } = await run('cloud-cost-hotspots', { respond: byLabel({ 'sweep:': CLAIMED }) })
  const verifications = callsLabelled(transcript, 'verify:')

  assert.strictEqual(verifications.length, callsLabelled(transcript, 'sweep:').length)
  for (const call of verifications) {
    assert.ok(call.prompt.includes('12000-18000'), 'the verifier must see the figure it is checking')
    assert.ok(call.prompt.includes('4 TB/month ingested'), 'and the assumptions the figure rests on')
  }
})

test('cloud-cost-hotspots: a refuted hotspot contributes nothing to the headline total', async () => {
  const { result } = await run('cloud-cost-hotspots', {
    respond: byLabel({
      'sweep:': CLAIMED,
      'verify:': { verdict: 'refuted', reason: 'the bucket already has a lifecycle rule set elsewhere' },
    }),
  })

  assert.deepStrictEqual(result.headlineSaving, { low: 0, high: 0, currency: 'USD' })
  assert.strictEqual(result.backlog.length, 0)
  assert.ok(result.refuted.length > 0, 'a refuted claim stays visible so the same hotspot is not re-reported next quarter')
  assert.match(result.refuted[0].reason, /lifecycle rule/)
})

test('cloud-cost-hotspots: an adjusted estimate replaces the sweeper figure', async () => {
  const { result } = await run('cloud-cost-hotspots', {
    respond: byLabel({
      'sweep:': CLAIMED,
      'verify:': { verdict: 'adjusted', reason: 'ingest is closer to 1 TB/month', annualLow: 3000, annualHigh: 4000 },
    }),
  })

  assert.strictEqual(result.headlineSaving.low, 3000 * result.surfacesSwept)
  assert.strictEqual(result.headlineSaving.high, 4000 * result.surfacesSwept)
  assert.strictEqual(result.backlog[0].confidence, 'adjusted')
  assert.deepStrictEqual(result.backlog[0].claimed, { low: 12000, high: 18000 }, 'the original claim is kept for comparison')
})

test('cloud-cost-hotspots: a confirmed estimate keeps the sweeper figure', async () => {
  const { result } = await run('cloud-cost-hotspots', {
    respond: byLabel({
      'sweep:': CLAIMED,
      'verify:': { verdict: 'confirmed', reason: 'independently re-derived, same range' },
    }),
  })

  assert.strictEqual(result.headlineSaving.low, 12000 * result.surfacesSwept)
  assert.strictEqual(result.backlog[0].confidence, 'confirmed')
})

test('cloud-cost-hotspots: every backlog entry is a change someone can make', async () => {
  const { result } = await run('cloud-cost-hotspots', { respond: byLabel({ 'sweep:': CLAIMED }) })

  assert.ok(result.backlog.length > 0)
  for (const entry of result.backlog) {
    for (const field of ['surface', 'location', 'change', 'confidence']) {
      assert.ok(typeof entry[field] === 'string' && entry[field].length > 0, `backlog entry is missing "${field}"`)
    }
    assert.strictEqual(typeof entry.savingBand.low, 'number')
    assert.strictEqual(entry.savingBand.currency, 'USD')
  }
  assert.match(result.caveat, /billing/i, 'the report must say these are code-derived, not invoiced, figures')
})

test('cloud-cost-hotspots: a repository with no infrastructure is an empty scope', async () => {
  const { result } = await run('cloud-cost-hotspots', { respond: scopingReturns(emptyFromSchema) })

  assert.strictEqual(result.emptyScope, true)
  assert.deepStrictEqual(result.headlineSaving, { low: 0, high: 0, currency: 'USD' })
})

// ── slo-readiness-audit ────────────────────────────────────────────────────

const TWO_SERVICES = {
  services: [
    { name: 'admin-tool', blastRadius: 'low', purpose: 'internal admin UI' },
    { name: 'payments', blastRadius: 'critical', purpose: 'card capture and settlement' },
  ],
}

const SMALL_RUBRIC = {
  name: 'Test rubric',
  dimensions: [
    { id: 'timeouts', name: 'Timeouts on outbound calls', severity: 'critical', check: 'every client sets a timeout' },
    { id: 'runbook', name: 'Runbook linked from alerts', severity: 'high', check: 'alerts link to real steps' },
  ],
}

test('slo-readiness-audit: one assessor per service, each given the whole rubric', async () => {
  const { transcript, result } = await run('slo-readiness-audit')
  const assessors = callsLabelled(transcript, 'assess:')

  assert.strictEqual(assessors.length, result.servicesAssessed)
  for (const call of assessors) {
    for (const dimension of result.dimensions) {
      assert.ok(call.prompt.includes(dimension), `assessor prompt must list dimension "${dimension}"`)
    }
    assert.ok(call.prompt.includes('Score EVERY dimension'), 'a partial assessment is not a scorecard')
  }
})

test('slo-readiness-audit: the default rubric covers the dimensions that cause outages', async () => {
  const { result } = await run('slo-readiness-audit')

  for (const expected of ['slo', 'alerting', 'timeouts', 'retries', 'rollback', 'ownership']) {
    assert.ok(result.dimensions.includes(expected), `default rubric is missing "${expected}"`)
  }
})

test('slo-readiness-audit: a supplied rubric replaces the default and is named in the result', async () => {
  const { transcript, result } = await run('slo-readiness-audit', { args: { rubric: SMALL_RUBRIC } })

  assert.strictEqual(result.rubric, 'Test rubric')
  assert.deepStrictEqual(result.dimensions, ['timeouts', 'runbook'])
  for (const call of callsLabelled(transcript, 'assess:')) {
    assert.ok(call.prompt.includes('Timeouts on outbound calls'))
    assert.ok(!call.prompt.includes('Circuit breaking'), 'the default rubric must not leak in')
  }
})

test('slo-readiness-audit: the fan-out is capped by maxServices', async () => {
  const oversized = byLabel({ 'discover-services': (call) => bigFromSchema(call.schema, 300) })

  const wide = await run('slo-readiness-audit', { respond: oversized })
  assert.strictEqual(callsLabelled(wide.transcript, 'assess:').length, 80)
  assert.strictEqual(wide.result.truncated, 220)

  const narrow = await run('slo-readiness-audit', { args: { maxServices: 3 }, respond: oversized })
  assert.strictEqual(callsLabelled(narrow.transcript, 'assess:').length, 3)
})

test('slo-readiness-audit: a refuted pass costs the service score', async () => {
  const allPass = {
    dimensions: SMALL_RUBRIC.dimensions.map((d) => ({ id: d.id, result: 'pass', evidence: 'looks present' })),
  }

  const confirmed = await run('slo-readiness-audit', {
    args: { rubric: SMALL_RUBRIC },
    respond: byLabel({
      'discover-services': TWO_SERVICES,
      'assess:': allPass,
      'verify:': { verdict: 'confirmed', reason: 'checked it' },
    }),
  })

  const refuted = await run('slo-readiness-audit', {
    args: { rubric: SMALL_RUBRIC },
    respond: byLabel({
      'discover-services': TWO_SERVICES,
      'assess:': allPass,
      'verify:': { verdict: 'refuted', reason: 'the timeout is only set in the test client' },
    }),
  })

  const confirmedScore = confirmed.result.scorecard.find((s) => s.service === 'payments').score
  const refutedScore = refuted.result.scorecard.find((s) => s.service === 'payments').score

  assert.strictEqual(confirmedScore, 100)
  assert.strictEqual(refutedScore, 0)
  assert.ok(refutedScore < confirmedScore, 'self-assessment that survives no check is not an audit')
  assert.strictEqual(refuted.result.verification.refuted, 4, '2 services x 2 dimensions')
  assert.strictEqual(refuted.result.tiers.notProductionReady, 2)
})

test('slo-readiness-audit: an unverifiable pass is downgraded to partial, not kept as a pass', async () => {
  const { result } = await run('slo-readiness-audit', {
    args: { rubric: SMALL_RUBRIC },
    respond: byLabel({
      'discover-services': TWO_SERVICES,
      'assess:': { dimensions: SMALL_RUBRIC.dimensions.map((d) => ({ id: d.id, result: 'pass', evidence: 'looks present' })) },
      'verify:': { verdict: 'unverified', reason: 'the alert definitions live in another repository' },
    }),
  })

  const payments = result.scorecard.find((s) => s.service === 'payments')
  assert.strictEqual(payments.score, 50, 'partial credit, not full credit')
  assert.strictEqual(result.verification.unverified, 4)
})

test('slo-readiness-audit: equal gaps rank by blast radius, not alphabetically', async () => {
  const { result } = await run('slo-readiness-audit', {
    args: { rubric: SMALL_RUBRIC },
    respond: byLabel({
      'discover-services': TWO_SERVICES,
      'assess:': {
        dimensions: SMALL_RUBRIC.dimensions.map((d) => ({ id: d.id, result: 'fail', evidence: 'absent', fix: 'add it' })),
      },
    }),
  })

  assert.strictEqual(result.backlog.length, 4)
  assert.strictEqual(
    result.backlog[0].service,
    'payments',
    'a gap on the payment path outranks the same gap on an admin tool',
  )
  assert.strictEqual(result.backlog[0].blastRadius, 'critical')
  assert.strictEqual(result.backlog.at(-1).service, 'admin-tool')

  // Within one service, the more severe dimension comes first.
  const paymentsGaps = result.backlog.filter((gap) => gap.service === 'payments')
  assert.deepStrictEqual(paymentsGaps.map((gap) => gap.dimension), ['timeouts', 'runbook'])
})

test('slo-readiness-audit: a dimension the assessor skipped is scored as a failure, not ignored', async () => {
  const { result } = await run('slo-readiness-audit', {
    args: { rubric: SMALL_RUBRIC },
    respond: byLabel({
      'discover-services': TWO_SERVICES,
      'assess:': { dimensions: [{ id: 'timeouts', result: 'pass', evidence: 'set in the http client' }] },
      'verify:': { verdict: 'confirmed', reason: 'checked it' },
    }),
  })

  const payments = result.scorecard.find((s) => s.service === 'payments')
  assert.ok(payments.failingDimensions.includes('runbook'), 'an unreported dimension must not be silently dropped')
  assert.ok(payments.score < 100)
})

test('slo-readiness-audit: a repository with no services is an empty scope', async () => {
  const { result } = await run('slo-readiness-audit', { respond: scopingReturns(emptyFromSchema) })

  assert.strictEqual(result.emptyScope, true)
  assert.deepStrictEqual(result.scorecard, [])
})
