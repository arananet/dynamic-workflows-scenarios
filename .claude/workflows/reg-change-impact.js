export const meta = {
  name: 'reg-change-impact',
  description:
    'Decompose a regulatory change into discrete engineering obligations, map every obligation onto the services and data flows it lands on, and return a staffable remediation backlog with owners, severity and effort bands.',
}

// The bottleneck in regulatory change is not reading the regulation — it is
// answering "which of our 400 services does clause 7 actually touch". That is a
// coverage problem, so it fans out. The cross-product of obligations and
// services is far past the runtime's agent budget, so a scoping phase ranks
// candidate pairs and the cap truncates the tail rather than the head.

const input = args ?? {}
const change = input.change ?? 'the regulatory change described by the operator'
const regime = input.regime ?? 'unspecified regime'
const deadline = input.deadline ?? 'no deadline supplied'
const maxAssessments = Math.max(1, input.maxAssessments ?? 60)

// ── Phase 1 — decompose the regulation into engineering obligations ────────
const decomposition = await agent(
  `Decompose this regulatory change into discrete ENGINEERING obligations.

Regime: ${regime}
Change: ${change}
Compliance deadline: ${deadline}

An engineering obligation is something a team could put on a board: "consent must be
re-captured before any secondary use of transaction data", "records must be retained for 10
years and be retrievable within 72 hours". Not "comply with Article 12".

For each obligation, state the observable system property that would satisfy it and the
signals in a codebase that indicate it is or is not met. Do not interpret the law beyond what
the supplied text supports — where the text is ambiguous, say so and state the reading you
used.`,
  {
    label: 'decompose-obligations',
    schema: {
      type: 'object',
      required: ['obligations'],
      properties: {
        obligations: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'statement', 'observableProperty', 'signals'],
            properties: {
              id: { type: 'string' },
              statement: { type: 'string' },
              observableProperty: { type: 'string' },
              signals: { type: 'array', items: { type: 'string' } },
              ambiguity: { type: 'string' },
            },
          },
        },
      },
    },
  },
)

const obligations = decomposition.obligations ?? []

// ── Phase 2 — scope: which services plausibly touch any of these ───────────
const scope = await agent(
  `Inventory the services, applications and data stores in this repository, then rank which of
them plausibly fall under the following obligations. Include a service if it handles the data
class, the user interaction, or the retention/reporting path the obligation concerns.

Obligations:
${obligations.map((o) => `- ${o.id}: ${o.statement}`).join('\n') || '- (none decomposed)'}

For each candidate, give the service, the obligation id it may fall under, why you think so,
and a confidence from 0 to 1. Rank the list most-likely-affected first: only the top
${maxAssessments} pairs will be assessed in depth, so put your best candidates at the top.`,
  {
    label: 'scope-affected-services',
    schema: {
      type: 'object',
      required: ['candidates'],
      properties: {
        candidates: {
          type: 'array',
          items: {
            type: 'object',
            required: ['service', 'obligationId', 'why', 'confidence'],
            properties: {
              service: { type: 'string' },
              path: { type: 'string' },
              obligationId: { type: 'string' },
              why: { type: 'string' },
              confidence: { type: 'number' },
            },
          },
        },
      },
    },
  },
)

const allCandidates = scope.candidates ?? []
const candidates = allCandidates.slice(0, maxAssessments)

if (obligations.length === 0 || candidates.length === 0) {
  return {
    workflow: meta.name,
    regime,
    change,
    deadline,
    emptyScope: true,
    reason:
      obligations.length === 0
        ? 'The change did not decompose into any engineering obligation — it may not have a system-level impact, or the supplied text was too thin.'
        : 'No service in this repository was ranked as plausibly in scope for any obligation.',
    obligations,
    truncated: 0,
    impacted: [],
    backlog: [],
  }
}

const obligationById = new Map(obligations.map((o) => [o.id, o]))

// ── Phase 3 — assess each ranked obligation × service pair ─────────────────
const assessments = await pipeline(candidates, (candidate) => {
  const obligation = obligationById.get(candidate.obligationId)
  return agent(
    `Assess whether "${candidate.service}" satisfies obligation ${candidate.obligationId}.

Obligation: ${obligation?.statement ?? candidate.obligationId}
Satisfied when: ${obligation?.observableProperty ?? 'see obligation statement'}
Look for these signals: ${(obligation?.signals ?? []).join('; ') || 'use your judgement'}
Why this service is a candidate: ${candidate.why}
${candidate.path ? `Start at: ${candidate.path}` : ''}

Read the code. Decide whether the obligation is already met, partially met, or not met, and
name the specific code paths, schemas, config or data flows that decide it. If the service
turns out not to be in scope at all, say "not-applicable" and explain why the scoping was
wrong — a removed service is as valuable as an added one.

Estimate remediation effort as one of: xs (< 1 day), s (1-3 days), m (1-2 weeks),
l (3-6 weeks), xl (a quarter or more).`,
    {
      label: `assess:${candidate.service}:${candidate.obligationId}`,
      schema: {
        type: 'object',
        required: ['status', 'severity', 'effort', 'evidence'],
        properties: {
          status: {
            type: 'string',
            enum: ['not-met', 'partially-met', 'met', 'not-applicable'],
          },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          effort: { type: 'string', enum: ['xs', 's', 'm', 'l', 'xl'] },
          evidence: { type: 'array', items: { type: 'string' } },
          remediation: { type: 'string' },
        },
      },
    },
  )
})

// ── Phase 4 — build the backlog in the script, from assessed data ──────────
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 }

const impacted = []
const outOfScope = []

for (let i = 0; i < candidates.length; i++) {
  const candidate = candidates[i]
  const assessment = assessments[i] ?? {}
  const record = {
    service: candidate.service,
    obligation: candidate.obligationId,
    obligationStatement: obligationById.get(candidate.obligationId)?.statement ?? '',
    status: assessment.status ?? 'not-met',
    severity: assessment.severity ?? 'medium',
    effort: assessment.effort ?? 'm',
    evidence: assessment.evidence ?? [],
    remediation: assessment.remediation ?? 'Remediation not specified by the assessment.',
    confidence: candidate.confidence ?? 0,
  }
  if (record.status === 'not-applicable' || record.status === 'met') outOfScope.push(record)
  else impacted.push(record)
}

const backlog = [...impacted].sort(
  (a, b) =>
    (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
    a.service.localeCompare(b.service),
)

// ── Phase 5 — programme-level summary ─────────────────────────────────────
const summary = await agent(
  `Summarise a regulatory impact assessment for the programme manager who has to staff it.

Regime: ${regime}. Deadline: ${deadline}.
Obligations: ${obligations.length}. Services assessed: ${candidates.length}.
Items needing work: ${impacted.length}. Already compliant or out of scope: ${outOfScope.length}.

Highest-severity items:
${backlog.slice(0, 10).map((b) => `- ${b.service} / ${b.obligation} (${b.severity}, ${b.effort}): ${b.remediation}`).join('\n') || '- none'}

State the critical path to the deadline, which obligations can be worked in parallel, and
which single item is most likely to slip the programme. Be blunt about whether the deadline
looks achievable.`,
  {
    label: 'summarise-programme',
    schema: {
      type: 'object',
      required: ['headline', 'deadlineOutlook', 'criticalPath'],
      properties: {
        headline: { type: 'string' },
        deadlineOutlook: { type: 'string', enum: ['achievable', 'at-risk', 'not-achievable'] },
        criticalPath: { type: 'array', items: { type: 'string' } },
        parallelisable: { type: 'array', items: { type: 'string' } },
      },
    },
  },
)

return {
  workflow: meta.name,
  regime,
  change,
  deadline,
  emptyScope: false,
  obligations,
  candidatesConsidered: allCandidates.length,
  candidatesAssessed: candidates.length,
  truncated: Math.max(0, allCandidates.length - candidates.length),
  headline: summary.headline,
  deadlineOutlook: summary.deadlineOutlook,
  criticalPath: summary.criticalPath ?? [],
  parallelisable: summary.parallelisable ?? [],
  impacted,
  outOfScope,
  backlog,
}
