export const meta = {
  name: 'strangler-fig-plan',
  description:
    'Map a legacy system\'s seams, draft three decomposition strategies from deliberately different angles, have each critiqued by agents who did not write it, score them against explicit criteria, and emit a sequenced migration roadmap for the winner.',
}

// Most migration plans are the plan of whoever argued hardest in the room. This
// workflow refuses to produce one plan. It produces three from angles that
// genuinely disagree, makes them attack each other, scores them against
// criteria fixed in advance, and attaches the losers to the roadmap — so the
// decision is auditable instead of asserted.

const ANGLES = [
  {
    id: 'domain',
    name: 'Domain boundaries',
    brief: `Decompose along business capability lines. Slices are bounded contexts with their
own language and rules. Optimise for teams being able to own a slice end to end, and accept
that data may need to be split awkwardly to respect a domain boundary.`,
  },
  {
    id: 'data',
    name: 'Data ownership',
    brief: `Decompose along data ownership. Start from the tables and the write paths: whoever
writes a table owns it, and a slice is only extractable once its write path is single-owner.
Optimise for never having two services writing the same table, and accept that a slice may
span business capabilities.`,
  },
  {
    id: 'traffic',
    name: 'Traffic and risk profile',
    brief: `Decompose along traffic and blast radius. Extract the highest-value, highest-risk
paths first while the team still has attention and budget, or the lowest-risk paths first to
build the extraction machinery safely — pick one and justify it. Optimise for learning fast
and for every step being independently reversible.`,
  },
]

const CRITERIA = [
  'Reversibility: can each step be rolled back without a data migration in reverse?',
  'Business continuity: how much of the plan requires a freeze, a big-bang cutover, or downtime?',
  'Team fit: can the org that exists today staff and own the resulting slices?',
  'Data integrity: does any step leave two writers on one dataset, even temporarily?',
  'Time to first value: how long until the first slice is in production and paying off?',
  'Failure containment: when a step goes wrong at 3am, how far does the damage spread?',
]

const input = args ?? {}
const system = input.system ?? 'the legacy system in this repository'
const constraints = input.constraints ?? 'no additional constraints supplied'
const horizon = input.horizon ?? 'unspecified'

// ── Phase 1 — map the seams ───────────────────────────────────────────────
const seamMap = await agent(
  `Map the seams of ${system} — the places where it could be cut.

Identify: the modules and their responsibilities, the shared data stores and who writes to
each, the synchronous call paths between modules, the shared state (sessions, caches, global
config), the integration points with external systems, and any component everything routes
through.

For each seam, note what makes it hard to cut: shared transactions, chatty coupling,
undocumented behaviour, missing tests. Do not propose a migration plan — this is the terrain
map three planners will work from.`,
  {
    label: 'map-seams',
    schema: {
      type: 'object',
      required: ['modules', 'seams'],
      properties: {
        modules: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'responsibility'],
            properties: {
              name: { type: 'string' },
              responsibility: { type: 'string' },
              path: { type: 'string' },
            },
          },
        },
        dataStores: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'writers'],
            properties: {
              name: { type: 'string' },
              writers: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        seams: {
          type: 'array',
          items: {
            type: 'object',
            required: ['between', 'difficulty'],
            properties: {
              between: { type: 'string' },
              difficulty: { type: 'string', enum: ['easy', 'moderate', 'hard', 'very-hard'] },
              blockers: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        chokepoints: { type: 'array', items: { type: 'string' } },
      },
    },
  },
)

const modules = seamMap.modules ?? []
const seams = seamMap.seams ?? []

if (modules.length === 0 || seams.length === 0) {
  return {
    workflow: meta.name,
    system,
    emptyScope: true,
    reason:
      modules.length === 0
        ? 'No modules were found — there is nothing here to decompose.'
        : 'No seams were found: the system may already be decomposed, or it may be too entangled for a seam to be identified from source alone.',
    modules,
    seams,
    plans: [],
    roadmap: [],
  }
}

const terrain = `Modules:
${modules.map((m) => `- ${m.name}: ${m.responsibility}`).join('\n')}

Data stores:
${(seamMap.dataStores ?? []).map((d) => `- ${d.name} written by: ${(d.writers ?? []).join(', ')}`).join('\n') || '- (none reported)'}

Seams:
${seams.map((s) => `- ${s.between} (${s.difficulty})${(s.blockers ?? []).length ? ` blocked by: ${s.blockers.join(', ')}` : ''}`).join('\n')}

Chokepoints: ${(seamMap.chokepoints ?? []).join(', ') || 'none reported'}`

// ── Phase 2 — three plans, three genuinely different angles ───────────────
const plans = await pipeline(ANGLES, (angle) =>
  agent(
    `Draft a strangler-fig decomposition plan for ${system} from ONE specific angle.

Your angle: ${angle.name}
${angle.brief}

Constraints: ${constraints}
Horizon: ${horizon}

Terrain:
${terrain}

Commit to your angle. Do not hedge toward the other possible angles or produce a compromise —
two other planners are arguing the alternatives and the plans will be scored against each
other. A plan that tries to be all three is the plan that loses.

Produce an ordered sequence of slices. For each slice: what moves out, what stays behind, how
traffic is redirected, how it rolls back, and what breaks if it goes wrong. State the single
biggest risk to your plan honestly — you will be cross-examined on it.`,
    {
      label: `plan:${angle.id}`,
      schema: {
        type: 'object',
        required: ['thesis', 'slices', 'biggestRisk'],
        properties: {
          thesis: { type: 'string' },
          slices: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'moves', 'remains', 'rollback', 'risk'],
              properties: {
                name: { type: 'string' },
                moves: { type: 'string' },
                remains: { type: 'string' },
                cutover: { type: 'string' },
                rollback: { type: 'string' },
                risk: { type: 'string' },
                duration: { type: 'string' },
              },
            },
          },
          biggestRisk: { type: 'string' },
          assumptions: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  ),
)

// ── Phase 3 — cross-critique: every plan reviewed by every rival angle ─────
const critiquePairs = []
for (let i = 0; i < ANGLES.length; i++) {
  for (let j = 0; j < ANGLES.length; j++) {
    if (i !== j) critiquePairs.push({ planIndex: i, criticIndex: j })
  }
}

const critiques = await pipeline(critiquePairs, ({ planIndex, criticIndex }) => {
  const plan = plans[planIndex]
  const target = ANGLES[planIndex]
  const critic = ANGLES[criticIndex]
  return agent(
    `You planned this migration from the "${critic.name}" angle. A rival planner has proposed
the following plan from the "${target.name}" angle. Find what is wrong with it.

Their thesis: ${plan?.thesis ?? '(no thesis)'}
Their slices:
${(plan?.slices ?? []).map((s, k) => `${k + 1}. ${s.name} — moves: ${s.moves}; remains: ${s.remains}; rollback: ${s.rollback}; risk: ${s.risk}`).join('\n') || '(no slices)'}
Risk they admit to: ${plan?.biggestRisk ?? '(none stated)'}

Terrain both of you are working from:
${terrain}

Attack the plan where your angle says it is weakest. Concretely: which slice leaves two
writers on one dataset, which cutover cannot actually be reversed, which boundary cuts through
a transaction, which step assumes a team that does not exist.

Be specific and be fair — an unfair critique is worthless because it will be discounted.
Where the rival plan beats yours, say so.`,
    {
      label: `critique:${target.id}<-${critic.id}`,
      schema: {
        type: 'object',
        required: ['objections', 'concedes'],
        properties: {
          objections: {
            type: 'array',
            items: {
              type: 'object',
              required: ['slice', 'objection', 'severity'],
              properties: {
                slice: { type: 'string' },
                objection: { type: 'string' },
                severity: { type: 'string', enum: ['fatal', 'serious', 'minor'] },
              },
            },
          },
          concedes: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  )
})

const critiquesByPlan = ANGLES.map(() => [])
for (let i = 0; i < critiquePairs.length; i++) {
  critiquesByPlan[critiquePairs[i].planIndex].push({
    critic: ANGLES[critiquePairs[i].criticIndex].id,
    ...critiques[i],
  })
}

// ── Phase 4 — score every plan against the same criteria ──────────────────
const scored = await pipeline(ANGLES, (angle, index) =>
  agent(
    `Score a migration plan against fixed criteria. You did not write any of the plans and you
are not defending one.

Plan angle: ${angle.name}
Thesis: ${plans[index]?.thesis ?? '(no thesis)'}
Slices: ${(plans[index]?.slices ?? []).map((s) => s.name).join(' → ') || '(none)'}

Objections raised by rival planners:
${critiquesByPlan[index].flatMap((c) => (c.objections ?? []).map((o) => `- [${o.severity}] ${o.slice}: ${o.objection}`)).join('\n') || '- none'}

Criteria, all weighted equally:
${CRITERIA.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Give an overall score from 0 to 100 and a per-criterion note. Weight sustained objections
heavily: a fatal objection that the plan has no answer to should cost it the comparison, no
matter how elegant the thesis is.`,
    {
      label: `score:${angle.id}`,
      schema: {
        type: 'object',
        required: ['score', 'rationale'],
        properties: {
          score: { type: 'number', minimum: 0 },
          rationale: { type: 'string' },
          criterionNotes: { type: 'array', items: { type: 'string' } },
          survivedObjections: { type: 'integer' },
        },
      },
    },
  ),
)

const evaluated = ANGLES.map((angle, index) => ({
  angle: angle.id,
  angleName: angle.name,
  thesis: plans[index]?.thesis ?? '',
  slices: plans[index]?.slices ?? [],
  biggestRisk: plans[index]?.biggestRisk ?? '',
  critiques: critiquesByPlan[index],
  score: scored[index]?.score ?? 0,
  rationale: scored[index]?.rationale ?? '',
}))

const best = evaluated.reduce((a, b) => (b.score > a.score ? b : a))
const rejected = evaluated.filter((plan) => plan.angle !== best.angle)

// ── Phase 5 — turn the winner into a roadmap that survived the argument ────
const roadmap = await agent(
  `Turn the winning decomposition plan into a sequenced migration roadmap.

Winning angle: ${best.angleName} (score ${best.score})
Thesis: ${best.thesis}
Slices: ${best.slices.map((s) => s.name).join(' → ') || '(none)'}

Objections it did NOT fully answer:
${best.critiques.flatMap((c) => (c.objections ?? []).filter((o) => o.severity !== 'minor').map((o) => `- ${o.slice}: ${o.objection}`)).join('\n') || '- none'}

Rejected alternatives: ${rejected.map((p) => `${p.angleName} (${p.score})`).join(', ')}

Produce the roadmap the winning plan should actually be, with the surviving objections folded
in as mitigations rather than ignored. Every step must name what moves, what remains, how it
rolls back, and its risk. Add an explicit "stop and reassess" trigger for each step: the
observable condition that means this decomposition is going wrong and the programme should
pause.`,
  {
    label: 'emit-roadmap',
    schema: {
      type: 'object',
      required: ['steps', 'summary'],
      properties: {
        summary: { type: 'string' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'moves', 'remains', 'rollback', 'risk', 'stopTrigger'],
            properties: {
              name: { type: 'string' },
              moves: { type: 'string' },
              remains: { type: 'string' },
              rollback: { type: 'string' },
              risk: { type: 'string' },
              stopTrigger: { type: 'string' },
              duration: { type: 'string' },
            },
          },
        },
        prerequisites: { type: 'array', items: { type: 'string' } },
      },
    },
  },
)

return {
  workflow: meta.name,
  system,
  constraints,
  horizon,
  emptyScope: false,
  seamMap: { modules, seams, chokepoints: seamMap.chokepoints ?? [] },
  criteria: CRITERIA,
  plans: evaluated.map((plan) => ({
    angle: plan.angle,
    angleName: plan.angleName,
    thesis: plan.thesis,
    score: plan.score,
    rationale: plan.rationale,
    critiqueCount: plan.critiques.length,
  })),
  selected: { angle: best.angle, angleName: best.angleName, score: best.score },
  rejected: rejected.map((plan) => ({
    angle: plan.angle,
    score: plan.score,
    whyNot: plan.rationale,
    fatalObjections: plan.critiques.flatMap((c) =>
      (c.objections ?? []).filter((o) => o.severity === 'fatal').map((o) => o.objection),
    ),
  })),
  summary: roadmap.summary,
  prerequisites: roadmap.prerequisites ?? [],
  roadmap: roadmap.steps ?? [],
}
