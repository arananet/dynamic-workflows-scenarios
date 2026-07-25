export const meta = {
  name: 'slo-readiness-audit',
  description:
    'Score every service against an explicit production-readiness rubric, independently verify each claimed pass, and return a scorecard plus a gap backlog ordered by blast radius rather than by raw severity.',
}

// An SRE team can name the ten services it worries about. This audit is about
// the ninety nobody has looked at. Two design choices matter: a claimed pass is
// verified by a different agent (self-assessment grades generously), and the
// backlog sorts by blast radius, because a medium gap on the payment path
// outranks a high gap on an internal admin tool — and a readiness report that
// ignores that gets ignored in turn.

const DEFAULT_RUBRIC = {
  name: 'Default production readiness rubric',
  dimensions: [
    { id: 'slo', name: 'SLO defined', severity: 'high', check: 'An availability or latency objective exists as an artefact — not a wish in a doc — with a target and a window.' },
    { id: 'alerting', name: 'Alerts map to the SLO', severity: 'critical', check: 'Alerts fire on symptoms users feel and trace back to the objective, rather than on CPU or on every log line.' },
    { id: 'runbook', name: 'Runbook exists and is linked', severity: 'high', check: 'Each alert links to a runbook with real steps, and the runbook has been touched more recently than the service was rewritten.' },
    { id: 'timeouts', name: 'Timeouts on every outbound call', severity: 'critical', check: 'Every network client sets an explicit timeout. A default-infinite client is a latent outage.' },
    { id: 'retries', name: 'Retries bounded with backoff and jitter', severity: 'high', check: 'Retries are capped, exponential and jittered. Unbounded or synchronised retries turn a blip into a retry storm.' },
    { id: 'breaker', name: 'Circuit breaking or load shedding', severity: 'medium', check: 'The service sheds load or opens a breaker rather than queueing until it dies.' },
    { id: 'degradation', name: 'Graceful degradation', severity: 'medium', check: 'A non-critical dependency failing degrades a feature rather than failing the request.' },
    { id: 'health', name: 'Meaningful health and readiness checks', severity: 'high', check: 'Readiness reflects the ability to serve, not just that the process started.' },
    { id: 'rollback', name: 'Tested rollback path', severity: 'critical', check: 'A deploy can be reversed without a reverse data migration, and someone has actually done it.' },
    { id: 'observability', name: 'Logs, metrics and traces usable under pressure', severity: 'medium', check: 'A responder can answer "which dependency is slow" at 3am from what is already emitted.' },
    { id: 'capacity', name: 'Known capacity limits', severity: 'medium', check: 'Someone can say what load this falls over at, from a test rather than a guess.' },
    { id: 'ownership', name: 'Named owner and on-call path', severity: 'high', check: 'A specific team owns it and a page reaches a human who can act.' },
  ],
}

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 }
const BLAST_RANK = { critical: 0, high: 1, medium: 2, low: 3 }
const SEVERITY_WEIGHT = { critical: 4, high: 3, medium: 2, low: 1 }

const input = args ?? {}
const maxServices = Math.max(1, input.maxServices ?? 80)

const suppliedRubric = input.rubric
const rubric = suppliedRubric
  ? {
      name: suppliedRubric.name ?? 'Operator-supplied rubric',
      dimensions: (suppliedRubric.dimensions ?? suppliedRubric).map((dimension, index) =>
        typeof dimension === 'string'
          ? { id: `d${index + 1}`, name: dimension, severity: 'high', check: dimension }
          : {
              id: dimension.id ?? `d${index + 1}`,
              name: dimension.name ?? dimension.id ?? `dimension ${index + 1}`,
              severity: dimension.severity ?? 'high',
              check: dimension.check ?? dimension.name ?? '',
            },
      ),
    }
  : DEFAULT_RUBRIC

const dimensionList = rubric.dimensions
  .map((d) => `- ${d.id} — ${d.name} (${d.severity}): ${d.check}`)
  .join('\n')

// ── Phase 1 — discover services and how much damage each one can do ───────
const discovery = await agent(
  `Inventory every independently deployable service, job or function in this repository.

For each: its name, where it lives, what it does, whether it is reachable from outside the
trust boundary, and what depends on it.

Then assign a blast radius: how much damage its failure does.
- critical: money moves through it, or its failure takes the product down
- high: a major user-facing capability fails
- medium: a feature degrades, or an internal team is blocked
- low: internal tooling, an admin surface, or a job that can be re-run later

Blast radius drives the whole report's ordering, so be honest about it — everything is not
critical.`,
  {
    label: 'discover-services',
    schema: {
      type: 'object',
      required: ['services'],
      properties: {
        services: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'blastRadius'],
            properties: {
              name: { type: 'string' },
              path: { type: 'string' },
              purpose: { type: 'string' },
              blastRadius: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
              externallyReachable: { type: 'boolean' },
            },
          },
        },
      },
    },
  },
)

const allServices = discovery.services ?? []
const services = allServices.slice(0, maxServices)

if (services.length === 0 || rubric.dimensions.length === 0) {
  return {
    workflow: meta.name,
    rubric: rubric.name,
    emptyScope: true,
    reason:
      rubric.dimensions.length === 0
        ? 'The supplied rubric had no dimensions — nothing to score against.'
        : 'No independently deployable services were found in this repository.',
    servicesConsidered: allServices.length,
    truncated: 0,
    scorecard: [],
    backlog: [],
  }
}

// ── Phase 2 — one assessor per service, scoring every dimension ───────────
const assessments = await pipeline(services, (service) =>
  agent(
    `Assess the production readiness of "${service.name}"${service.path ? ` at ${service.path}` : ''}.
Blast radius: ${service.blastRadius}. ${service.purpose ?? ''}

Score EVERY dimension below. Do not skip a dimension because it seems unlikely to apply — mark
it "not-applicable" with a reason if it genuinely does not.

${dimensionList}

For each dimension return pass, partial, fail or not-applicable, with the specific evidence
that decides it: a file, a config block, an alert definition, a runbook link. Another reviewer
will independently check every "pass" you claim, so do not award one on the strength of a
plausible-looking filename.

Where a dimension fails, state the smallest change that would make it pass.`,
    {
      label: `assess:${service.name}`,
      schema: {
        type: 'object',
        required: ['dimensions'],
        properties: {
          dimensions: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'result', 'evidence'],
              properties: {
                id: { type: 'string' },
                result: { type: 'string', enum: ['pass', 'partial', 'fail', 'not-applicable'] },
                evidence: { type: 'string' },
                fix: { type: 'string' },
              },
            },
          },
        },
      },
    },
  ),
)

// ── Phase 3 — verify claimed passes; self-assessment grades generously ────
const passClaims = []
for (let i = 0; i < services.length; i++) {
  for (const dimension of assessments[i]?.dimensions ?? []) {
    if (dimension.result === 'pass') {
      passClaims.push({ serviceIndex: i, service: services[i], dimension })
    }
  }
}

const verifications = await pipeline(passClaims, ({ service, dimension }) => {
  const spec = rubric.dimensions.find((d) => d.id === dimension.id)
  return agent(
    `An assessor claims "${service.name}" PASSES a production-readiness dimension. Check it
independently — you are the reason this report can be trusted.

Dimension: ${spec?.name ?? dimension.id}
Passes when: ${spec?.check ?? 'see dimension name'}
Claimed evidence: ${dimension.evidence}

Go and look. Then decide:
- Does the evidence exist where claimed?
- Does it satisfy the dimension fully, or only in the happy path / one environment / one code path?
- Would it hold at 3am under load, or only in the diagram?

Return "confirmed" only if you verified it yourself, "refuted" if it does not hold, and
"unverified" if you could not check. A generous "confirmed" here produces a readiness score
that gets someone paged for an outage this report said could not happen.`,
    {
      label: `verify:${service.name}:${dimension.id}`,
      schema: {
        type: 'object',
        required: ['verdict', 'reason'],
        properties: {
          verdict: { type: 'string', enum: ['confirmed', 'refuted', 'unverified'] },
          reason: { type: 'string' },
        },
      },
    },
  )
})

const verdictByClaim = new Map()
for (let i = 0; i < passClaims.length; i++) {
  const claim = passClaims[i]
  verdictByClaim.set(`${claim.serviceIndex}:${claim.dimension.id}`, verifications[i] ?? {})
}

// ── Phase 4 — score in the script, from verified results ──────────────────
const RESULT_CREDIT = { pass: 1, partial: 0.5, fail: 0, 'not-applicable': null }

const scorecard = []
const backlog = []

for (let i = 0; i < services.length; i++) {
  const service = services[i]
  const reported = assessments[i]?.dimensions ?? []
  const byId = new Map(reported.map((d) => [d.id, d]))

  let earned = 0
  let possible = 0
  const failing = []

  for (const spec of rubric.dimensions) {
    const reportedDimension = byId.get(spec.id) ?? { id: spec.id, result: 'fail', evidence: 'Not assessed.' }
    let result = reportedDimension.result

    if (result === 'pass') {
      const verdict = verdictByClaim.get(`${i}:${spec.id}`)?.verdict ?? 'unverified'
      if (verdict === 'refuted') result = 'fail'
      else if (verdict === 'unverified') result = 'partial'
    }

    const credit = RESULT_CREDIT[result]
    if (credit === null || credit === undefined) continue

    const weight = SEVERITY_WEIGHT[spec.severity] ?? 2
    possible += weight
    earned += weight * credit

    if (result !== 'pass') {
      const gap = {
        service: service.name,
        blastRadius: service.blastRadius,
        dimension: spec.id,
        dimensionName: spec.name,
        severity: spec.severity,
        result,
        evidence: reportedDimension.evidence ?? '',
        fix: reportedDimension.fix ?? `Implement: ${spec.check}`,
        verification: verdictByClaim.get(`${i}:${spec.id}`)?.reason ?? null,
      }
      failing.push(gap)
      backlog.push(gap)
    }
  }

  const score = possible > 0 ? Math.round((earned / possible) * 100) : 0
  const tier = score >= 90 ? 'ready' : score >= 70 ? 'acceptable' : score >= 50 ? 'at-risk' : 'not-production-ready'

  scorecard.push({
    service: service.name,
    path: service.path ?? null,
    blastRadius: service.blastRadius,
    score,
    tier,
    failingDimensions: failing.map((gap) => gap.dimension),
    gaps: failing,
  })
}

// Blast radius first, then severity: a medium gap on the payment path outranks
// a high gap on an internal admin tool.
backlog.sort(
  (a, b) =>
    (BLAST_RANK[a.blastRadius] ?? 9) - (BLAST_RANK[b.blastRadius] ?? 9) ||
    (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
    a.service.localeCompare(b.service),
)

scorecard.sort(
  (a, b) => (BLAST_RANK[a.blastRadius] ?? 9) - (BLAST_RANK[b.blastRadius] ?? 9) || a.score - b.score,
)

// ── Phase 5 — the number that goes in the QBR ─────────────────────────────
const summary = await agent(
  `Summarise a production readiness audit for an engineering director.

Rubric: ${rubric.name} (${rubric.dimensions.length} dimensions).
Services assessed: ${services.length} of ${allServices.length} discovered.
Not production ready: ${scorecard.filter((s) => s.tier === 'not-production-ready').length}.
At risk: ${scorecard.filter((s) => s.tier === 'at-risk').length}.
Claimed passes independently refuted: ${verifications.filter((v) => v?.verdict === 'refuted').length}.

Weakest critical-blast-radius services:
${scorecard.filter((s) => s.blastRadius === 'critical').slice(0, 8).map((s) => `- ${s.service}: ${s.score}/100 (${s.tier}) missing ${s.failingDimensions.join(', ') || 'nothing'}`).join('\n') || '- none'}

Top of the gap backlog:
${backlog.slice(0, 12).map((g) => `- [${g.blastRadius}] ${g.service}: ${g.dimensionName} (${g.severity}) — ${g.fix}`).join('\n') || '- none'}

Answer three questions a director actually has: which services would you not want to be on call
for tonight, which single gap repeated across many services is worth fixing as a platform
capability rather than service by service, and what is the smallest amount of work that moves
the most services out of "not production ready".`,
  {
    label: 'summarise-readiness',
    schema: {
      type: 'object',
      required: ['headline', 'wouldNotWantOnCall', 'platformFix', 'quickestWins'],
      properties: {
        headline: { type: 'string' },
        wouldNotWantOnCall: { type: 'array', items: { type: 'string' } },
        platformFix: { type: 'string' },
        quickestWins: { type: 'array', items: { type: 'string' } },
      },
    },
  },
)

return {
  workflow: meta.name,
  rubric: rubric.name,
  dimensions: rubric.dimensions.map((d) => d.id),
  emptyScope: false,
  servicesConsidered: allServices.length,
  servicesAssessed: services.length,
  truncated: Math.max(0, allServices.length - services.length),
  headline: summary.headline,
  wouldNotWantOnCall: summary.wouldNotWantOnCall ?? [],
  platformFix: summary.platformFix,
  quickestWins: summary.quickestWins ?? [],
  verification: {
    passesClaimed: passClaims.length,
    confirmed: verifications.filter((v) => v?.verdict === 'confirmed').length,
    refuted: verifications.filter((v) => v?.verdict === 'refuted').length,
    unverified: verifications.filter((v) => v?.verdict === 'unverified').length,
  },
  tiers: {
    ready: scorecard.filter((s) => s.tier === 'ready').length,
    acceptable: scorecard.filter((s) => s.tier === 'acceptable').length,
    atRisk: scorecard.filter((s) => s.tier === 'at-risk').length,
    notProductionReady: scorecard.filter((s) => s.tier === 'not-production-ready').length,
  },
  scorecard,
  backlog,
}
