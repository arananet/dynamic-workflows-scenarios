export const meta = {
  name: 'incident-forensics',
  description:
    'Reconstruct an incident window from repository artefacts, generate competing causal hypotheses in parallel, cross-examine each one using an agent invested in a rival explanation, and return a post-mortem draft with an evidence-linked timeline.',
}

// One responder can hold one story at a time, and the first plausible story
// usually wins. This workflow generates four stories from different classes of
// cause at once and then makes them fight. Examiners are primed with a RIVAL
// hypothesis rather than asked to critique neutrally: a neutral critique of a
// plausible story tends to agree with it, while an examiner with a stake in a
// different story finds the holes.

const CAUSE_CLASSES = [
  {
    id: 'code',
    name: 'Application code change',
    brief: `Something merged or deployed in the window changed behaviour: a logic change, a
refactor with a missed case, a dependency bump that shifted semantics, an error path that was
never exercised.`,
  },
  {
    id: 'config',
    name: 'Configuration, flag or environment change',
    brief: `The code was fine and the environment moved: a feature flag flip, a limit or
timeout changed, a credential or endpoint rotated, an infrastructure parameter edited, a
setting that differs between environments.`,
  },
  {
    id: 'data',
    name: 'Data, schema or migration',
    brief: `The data moved under the code: a migration, an index change, a backfill, a schema
edit, a growth threshold crossed, unexpected input shape from upstream.`,
  },
  {
    id: 'load',
    name: 'Load, capacity or upstream dependency',
    brief: `Nothing in this repository changed at all: traffic pattern shifted, a downstream
dependency degraded, a scheduled job collided with peak, a resource limit was reached, a
retry storm amplified a small failure.`,
  },
]

const input = args ?? {}
const window = input.window ?? 'the incident window supplied by the operator'
const symptoms = input.symptoms ?? 'the symptoms supplied by the operator'
const services = input.services ?? []

// ── Phase 1 — reconstruct the timeline from what the repository holds ─────
const timeline = await agent(
  `Reconstruct a change timeline for an incident.

Window: ${window}
Symptoms: ${symptoms}
${services.length ? `Services involved: ${services.join(', ')}` : ''}

Collect every change artefact in and shortly before the window: commits and merges,
release-shaped changes (tags, version bumps, changelog entries), configuration and
infrastructure-as-code edits, feature flag definition changes, database migrations, dependency
manifest and lockfile changes, and scheduled job definitions that would have fired in it.

For each artefact record when it happened, what it touched, and who authored it. Order them.
Do not speculate about cause — this is the evidence base four independent analysts will use.
State explicitly which classes of evidence you could NOT see from this repository (runtime
metrics, logs, cloud audit trails, manual console changes), because that is where the analysis
will be blind.`,
  {
    label: 'reconstruct-timeline',
    schema: {
      type: 'object',
      required: ['artefacts', 'blindSpots'],
      properties: {
        artefacts: {
          type: 'array',
          items: {
            type: 'object',
            required: ['when', 'what', 'kind'],
            properties: {
              when: { type: 'string' },
              what: { type: 'string' },
              kind: {
                type: 'string',
                enum: ['commit', 'release', 'config', 'infra', 'flag', 'migration', 'dependency', 'schedule'],
              },
              touched: { type: 'array', items: { type: 'string' } },
              author: { type: 'string' },
              reference: { type: 'string' },
            },
          },
        },
        blindSpots: { type: 'array', items: { type: 'string' } },
      },
    },
  },
)

const artefacts = timeline.artefacts ?? []
const blindSpots = timeline.blindSpots ?? []

if (artefacts.length === 0) {
  return {
    workflow: meta.name,
    window,
    symptoms,
    emptyScope: true,
    reason:
      'No change artefacts were found in the incident window. Either nothing in this repository changed — which itself points at load, an upstream dependency, or a change made outside version control — or the window is wrong.',
    blindSpots,
    timeline: [],
    hypotheses: [],
    rejected: [],
    contributingFactors: [],
  }
}

const evidence = artefacts
  .map((a) => `- [${a.when}] (${a.kind}) ${a.what}${a.author ? ` — ${a.author}` : ''}${a.reference ? ` [${a.reference}]` : ''}`)
  .join('\n')

// ── Phase 2 — four hypotheses, four different classes of cause ────────────
const hypotheses = await pipeline(CAUSE_CLASSES, (causeClass) =>
  agent(
    `Build the strongest possible causal explanation for this incident from ONE class of cause.

Your class: ${causeClass.name}
${causeClass.brief}

Window: ${window}
Symptoms: ${symptoms}
Known blind spots: ${blindSpots.join('; ') || 'none reported'}

Timeline evidence:
${evidence}

Argue your class as well as it can honestly be argued. Read the actual artefacts — do not
theorise from their titles. Build the mechanism: what specifically changed, why that produces
exactly these symptoms, and why the timing fits.

Then state, honestly, the single piece of evidence that would most damage your explanation, and
whether it exists. Three other analysts are building rival explanations and will cross-examine
you; a hypothesis that hides its weak point loses on contact.

If your class genuinely does not fit the evidence, say so and give it low confidence. A
confident wrong story is the expensive failure mode here.`,
    {
      label: `hypothesis:${causeClass.id}`,
      schema: {
        type: 'object',
        required: ['claim', 'mechanism', 'supportingEvidence', 'confidence', 'weakestPoint'],
        properties: {
          claim: { type: 'string' },
          mechanism: { type: 'string' },
          supportingEvidence: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number', minimum: 0 },
          weakestPoint: { type: 'string' },
          wouldDisproveIf: { type: 'string' },
        },
      },
    },
  ),
)

// ── Phase 3 — cross-examination by analysts invested in a rival story ─────
const examPairs = []
for (let i = 0; i < CAUSE_CLASSES.length; i++) {
  for (let j = 0; j < CAUSE_CLASSES.length; j++) {
    if (i !== j) examPairs.push({ target: i, examiner: j })
  }
}

const examinations = await pipeline(examPairs, ({ target, examiner }) => {
  const targetClass = CAUSE_CLASSES[target]
  const examinerClass = CAUSE_CLASSES[examiner]
  const hypothesis = hypotheses[target]
  const rival = hypotheses[examiner]
  return agent(
    `You built the "${examinerClass.name}" explanation for this incident. A rival analyst has
built the "${targetClass.name}" explanation. Cross-examine it.

Their claim: ${hypothesis?.claim ?? '(none)'}
Their mechanism: ${hypothesis?.mechanism ?? '(none)'}
Their supporting evidence: ${(hypothesis?.supportingEvidence ?? []).join('; ') || '(none)'}
The weak point they admit to: ${hypothesis?.weakestPoint ?? '(none stated)'}

Your own claim, for context: ${rival?.claim ?? '(none)'}

Timeline evidence available to both of you:
${evidence}

Test their explanation against the evidence, not against your preference. Specifically:
- Does the timing actually fit, to the precision the evidence supports?
- Does the mechanism explain ALL the symptoms, or only the convenient ones?
- Is any piece of their supporting evidence being over-read?
- Is there evidence in the timeline that contradicts them outright?

Rate the damage you did: "fatal" if the explanation cannot survive, "serious" if it needs
significant repair, "minor" if it stands with caveats, "none" if it survives intact. Concede
where they are right — an examiner who finds fatal flaws in every rival is not being read.`,
    {
      label: `examine:${targetClass.id}<-${examinerClass.id}`,
      schema: {
        type: 'object',
        required: ['damage', 'findings'],
        properties: {
          damage: { type: 'string', enum: ['none', 'minor', 'serious', 'fatal'] },
          findings: { type: 'array', items: { type: 'string' } },
          concedes: { type: 'string' },
        },
      },
    },
  )
})

// ── Phase 4 — score survival in the script, not in an agent's head ────────
const DAMAGE_COST = { none: 0, minor: 5, serious: 25, fatal: 60 }

const examsByTarget = CAUSE_CLASSES.map(() => [])
for (let i = 0; i < examPairs.length; i++) {
  examsByTarget[examPairs[i].target].push({
    examiner: CAUSE_CLASSES[examPairs[i].examiner].id,
    ...examinations[i],
  })
}

const assessed = CAUSE_CLASSES.map((causeClass, index) => {
  const hypothesis = hypotheses[index] ?? {}
  const exams = examsByTarget[index]
  const damage = exams.reduce((total, exam) => total + (DAMAGE_COST[exam.damage] ?? 0), 0)
  const stated = typeof hypothesis.confidence === 'number' ? hypothesis.confidence : 0
  const base = stated <= 1 ? stated * 100 : stated
  return {
    causeClass: causeClass.id,
    causeName: causeClass.name,
    claim: hypothesis.claim ?? '',
    mechanism: hypothesis.mechanism ?? '',
    supportingEvidence: hypothesis.supportingEvidence ?? [],
    weakestPoint: hypothesis.weakestPoint ?? '',
    examinations: exams,
    fatalCount: exams.filter((exam) => exam.damage === 'fatal').length,
    survival: Math.max(0, base - damage),
  }
})

const ranked = [...assessed].sort((a, b) => b.survival - a.survival)
const leading = ranked[0]
const rejected = ranked.slice(1)

// ── Phase 5 — the post-mortem draft a human reviews, not publishes ────────
const postMortem = await agent(
  `Draft the post-mortem for this incident.

Window: ${window}
Symptoms: ${symptoms}
Blind spots in the evidence: ${blindSpots.join('; ') || 'none reported'}

Leading explanation after cross-examination (survival score ${leading.survival}):
${leading.claim}
Mechanism: ${leading.mechanism}
Damage it sustained: ${leading.examinations.map((e) => `${e.examiner}=${e.damage}`).join(', ')}

Rejected explanations:
${rejected.map((r) => `- ${r.causeName} (${r.survival}): ${r.claim} — sunk by: ${r.examinations.flatMap((e) => e.findings ?? []).slice(0, 2).join('; ') || 'lower survival'}`).join('\n')}

Timeline:
${evidence}

Write a blameless post-mortem draft. State the leading cause and how confident the evidence
actually supports being. List the rejected explanations WITH the evidence that sank them —
a post-mortem that only tells the winning story teaches nobody anything.

Separate the trigger from the contributing factors: the flag flip is the trigger, the missing
alert and the untested rollback path are why it lasted 90 minutes. Contributing factors are
the actionable output; make each one a concrete change, not a sentiment.

Where a blind spot means you cannot know something, say so plainly rather than filling the gap
with a plausible sentence.`,
  {
    label: 'draft-post-mortem',
    schema: {
      type: 'object',
      required: ['leadingCause', 'confidence', 'trigger', 'contributingFactors', 'rejected'],
      properties: {
        leadingCause: { type: 'string' },
        confidence: { type: 'string', enum: ['high', 'moderate', 'low', 'insufficient-evidence'] },
        trigger: { type: 'string' },
        contributingFactors: {
          type: 'array',
          items: {
            type: 'object',
            required: ['factor', 'action'],
            properties: {
              factor: { type: 'string' },
              action: { type: 'string' },
              owner: { type: 'string' },
            },
          },
        },
        rejected: {
          type: 'array',
          items: {
            type: 'object',
            required: ['explanation', 'reason'],
            properties: {
              explanation: { type: 'string' },
              reason: { type: 'string' },
            },
          },
        },
        openQuestions: { type: 'array', items: { type: 'string' } },
      },
    },
  },
)

return {
  workflow: meta.name,
  window,
  symptoms,
  emptyScope: false,
  blindSpots,
  timeline: artefacts,
  leadingCause: postMortem.leadingCause,
  confidence: postMortem.confidence,
  trigger: postMortem.trigger,
  contributingFactors: postMortem.contributingFactors ?? [],
  rejected: (postMortem.rejected ?? []).length
    ? postMortem.rejected
    : rejected.map((r) => ({ explanation: r.claim, reason: `survival ${r.survival} after cross-examination` })),
  openQuestions: postMortem.openQuestions ?? [],
  hypotheses: assessed.map((h) => ({
    causeClass: h.causeClass,
    causeName: h.causeName,
    claim: h.claim,
    survival: h.survival,
    fatalObjections: h.fatalCount,
    examinationCount: h.examinations.length,
  })),
  selected: { causeClass: leading.causeClass, survival: leading.survival },
}
