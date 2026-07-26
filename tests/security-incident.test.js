import test from 'node:test'
import assert from 'node:assert/strict'
import { bigFromSchema, byLabel, callsLabelled, emptyFromSchema, firstIndexOf, run, scopingReturns } from './helpers.js'

// ── cve-blast-radius ───────────────────────────────────────────────────────

const oversizedAdvisory = byLabel({ 'resolve-advisory': (call) => bigFromSchema(call.schema, 250) })

test('cve-blast-radius: the advisory is resolved into symbols before anything is analysed', async () => {
  const { result, transcript } = await run('cve-blast-radius', {
    args: { id: 'CVE-2026-0001', advisory: 'Deserialisation flaw in acme-parser < 4.2.1' },
  })

  assert.strictEqual(firstIndexOf(transcript, 'resolve-advisory'), 0)
  assert.ok(firstIndexOf(transcript, 'reach:') > 0)
  assert.ok(typeof result.component === 'string' && result.component.length > 0)
  assert.ok(result.vulnerableSymbols.length > 0, 'presence-only triage is what this workflow exists to replace')
})

test('cve-blast-radius: the reachability fan-out is capped and truncation is reported', async () => {
  const wide = await run('cve-blast-radius', { respond: oversizedAdvisory })
  assert.strictEqual(callsLabelled(wide.transcript, 'reach:').length, 100)
  assert.strictEqual(wide.result.candidatesConsidered, 250)
  assert.strictEqual(wide.result.truncated, 150)

  const narrow = await run('cve-blast-radius', { args: { maxCandidates: 10 }, respond: oversizedAdvisory })
  assert.strictEqual(callsLabelled(narrow.transcript, 'reach:').length, 10)
})

test('cve-blast-radius: only reachable verdicts are challenged', async () => {
  const reachable = await run('cve-blast-radius', {
    respond: byLabel({ 'reach:': { verdict: 'reachable', reasoning: 'HTTP handler passes the body straight in' } }),
  })
  assert.strictEqual(
    callsLabelled(reachable.transcript, 'challenge:').length,
    callsLabelled(reachable.transcript, 'reach:').length,
  )

  const unreachable = await run('cve-blast-radius', {
    respond: byLabel({ 'reach:': { verdict: 'not-reachable', reasoning: 'the symbol is never imported' } }),
  })
  assert.strictEqual(
    callsLabelled(unreachable.transcript, 'challenge:').length,
    0,
    'challenging a not-reachable verdict spends tokens on a non-decision',
  )
})

test('cve-blast-radius: a refuted reachability claim is downgraded, not deleted', async () => {
  const { result } = await run('cve-blast-radius', {
    respond: byLabel({
      'reach:': { verdict: 'reachable', reasoning: 'looks reachable' },
      'challenge:': { verdict: 'refuted', reason: 'the call sits behind a flag that is off in every environment' },
    }),
  })

  assert.strictEqual(result.exposure.confirmed, 0)
  assert.ok(result.exposure.refuted > 0)
  assert.strictEqual(
    result.remediation.filter((entry) => entry.priority === 'P0').length,
    0,
    'a refuted claim must not page anyone tonight',
  )
  const downgraded = result.remediation.find((entry) => entry.verdict === 'reachable-refuted')
  assert.ok(downgraded, 'the refuted candidate stays in the report')
  assert.match(downgraded.challengedBy, /behind a flag/)
})

test('cve-blast-radius: an unverifiable challenge is never reported as safe', async () => {
  const { result } = await run('cve-blast-radius', {
    respond: byLabel({
      'reach:': { verdict: 'reachable', reasoning: 'looks reachable' },
      'challenge:': { verdict: 'unverified', reason: 'the dependency source was not vendored' },
    }),
  })

  assert.ok(result.unverified.length > 0)
  assert.strictEqual(result.exposure.confirmed, 0)
  assert.strictEqual(result.exposure.notReachable, 0)
  for (const entry of result.unverified) {
    assert.notStrictEqual(entry.verdict, 'not-reachable')
  }
})

test('cve-blast-radius: a confirmed internet-facing verdict lands at P0 and sorts first', async () => {
  const { result } = await run('cve-blast-radius', {
    respond: byLabel({
      'reach:': { verdict: 'reachable', reasoning: 'reachable from the public API' },
      'challenge:': { verdict: 'confirmed', reason: 'traced it myself', revisedExposure: 'internet-facing' },
    }),
  })

  assert.ok(result.exposure.confirmed > 0)
  assert.strictEqual(result.remediation[0].priority, 'P0')
})

test('cve-blast-radius: every remediation entry is actionable', async () => {
  const { result } = await run('cve-blast-radius')

  assert.ok(result.remediation.length > 0)
  for (const entry of result.remediation) {
    for (const field of ['candidate', 'verdict', 'priority', 'action']) {
      assert.ok(
        typeof entry[field] === 'string' && entry[field].length > 0,
        `remediation entry is missing "${field}"`,
      )
    }
  }
})

test('cve-blast-radius: a component that is not present is an empty scope', async () => {
  const { result } = await run('cve-blast-radius', { respond: scopingReturns(emptyFromSchema) })

  assert.strictEqual(result.emptyScope, true)
  assert.strictEqual(result.remediation.length, 0)
})

// ── incident-forensics ─────────────────────────────────────────────────────

test('incident-forensics: the timeline is built before any hypothesis exists', async () => {
  const { result, transcript } = await run('incident-forensics', {
    args: { window: '2026-07-20 14:00-15:30 UTC', symptoms: 'checkout 5xx rate at 40%' },
  })

  assert.strictEqual(firstIndexOf(transcript, 'reconstruct-timeline'), 0)
  assert.ok(firstIndexOf(transcript, 'hypothesis:') > 0)
  assert.ok(result.timeline.length > 0)
})

test('incident-forensics: at least three hypotheses, each from a different class of cause', async () => {
  const { transcript, result } = await run('incident-forensics')
  const hypotheses = callsLabelled(transcript, 'hypothesis:')

  assert.ok(hypotheses.length >= 3)
  assert.strictEqual(new Set(hypotheses.map((c) => c.label)).size, hypotheses.length)

  const classes = hypotheses.map((call) => call.prompt.match(/Your class: (.+)/)?.[1])
  assert.strictEqual(new Set(classes).size, hypotheses.length, 'each analyst must be pointed at a different cause class')
  assert.strictEqual(result.hypotheses.length, hypotheses.length)
})

test('incident-forensics: every hypothesis is cross-examined equally, by rivals only', async () => {
  const { transcript, result } = await run('incident-forensics')
  const exams = callsLabelled(transcript, 'examine:')

  const perTarget = new Map()
  for (const call of exams) {
    const [target, examiner] = call.label.slice('examine:'.length).split('<-')
    assert.notStrictEqual(target, examiner, 'nobody cross-examines their own hypothesis')
    perTarget.set(target, (perTarget.get(target) ?? 0) + 1)
  }

  assert.strictEqual(perTarget.size, result.hypotheses.length)
  assert.strictEqual([...new Set(perTarget.values())].length, 1, 'unequal attention biases the ranking')
  assert.deepStrictEqual([...new Set(result.hypotheses.map((h) => h.examinationCount))], [
    result.hypotheses.length - 1,
  ])
})

test('incident-forensics: sustained fatal objections sink a hypothesis', async () => {
  const { result } = await run('incident-forensics', {
    respond: byLabel({
      'hypothesis:': { claim: 'a claim', mechanism: 'a mechanism', supportingEvidence: ['x'], confidence: 0.9, weakestPoint: 'timing' },
      'examine:code<-': { damage: 'fatal', findings: ['the commit shipped after the incident started'] },
      'examine:': { damage: 'none', findings: [] },
    }),
  })

  const code = result.hypotheses.find((h) => h.causeClass === 'code')
  assert.strictEqual(code.fatalObjections, result.hypotheses.length - 1)
  assert.notStrictEqual(result.selected.causeClass, 'code', 'a hypothesis every rival killed must not lead')
  for (const other of result.hypotheses.filter((h) => h.causeClass !== 'code')) {
    assert.ok(other.survival > code.survival)
  }
})

test('incident-forensics: the post-mortem keeps the rejected explanations and their reasons', async () => {
  const { result } = await run('incident-forensics')

  assert.ok(typeof result.leadingCause === 'string' && result.leadingCause.length > 0)
  assert.ok(result.rejected.length > 0, 'a post-mortem that only tells the winning story teaches nobody anything')
  for (const rejected of result.rejected) {
    assert.ok(typeof rejected.reason === 'string' && rejected.reason.length > 0)
  }
  assert.ok(result.contributingFactors.length > 0)
  for (const factor of result.contributingFactors) {
    assert.ok(typeof factor.factor === 'string' && factor.factor.length > 0)
    assert.ok(typeof factor.action === 'string' && factor.action.length > 0, 'a contributing factor without an action is a sentiment')
  }
})

test('incident-forensics: blind spots in the evidence are carried into the report', async () => {
  const { result } = await run('incident-forensics', {
    respond: byLabel({
      'reconstruct-timeline': {
        artefacts: [{ when: '14:02', what: 'flag flip', kind: 'flag' }],
        blindSpots: ['no access to cloud audit logs'],
      },
    }),
  })

  assert.deepStrictEqual(result.blindSpots, ['no access to cloud audit logs'])
})

test('incident-forensics: an empty window is reported as evidence in itself', async () => {
  const { result, transcript } = await run('incident-forensics', { respond: scopingReturns(emptyFromSchema) })

  assert.strictEqual(result.emptyScope, true)
  assert.match(result.reason, /load|upstream|outside version control/i)
  assert.strictEqual(callsLabelled(transcript, 'hypothesis:').length, 0)
})
