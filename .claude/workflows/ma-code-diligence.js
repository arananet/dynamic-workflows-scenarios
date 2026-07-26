export const meta = {
  name: 'ma-code-diligence',
  description:
    'Run technical due diligence over an acquisition target across independent risk lenses, then reconcile them into a red-flag memo that separates deal-breakers from price adjustments and post-close work.',
}

// Diligence usually fails because a small team samples a small fraction of the
// code under time pressure. Fanning out fixes coverage; keeping the lenses
// independent fixes something subtler. If lenses could read each other, their
// findings would correlate and correlation reads as corroboration. Each lens
// here sees only the code.

const LENSES = {
  licensing: {
    title: 'Licence and IP risk',
    brief: `Find every dependency, vendored source tree, code snippet and asset whose licence
creates an obligation or a restriction: copyleft (GPL/AGPL/SSPL) reaching production code,
"source available" licences masquerading as open source, missing or ambiguous licences, and
attribution requirements nobody is meeting. Flag anything that would contaminate proprietary
code or restrict commercial redistribution.`,
  },
  secrets: {
    title: 'Secret and credential hygiene',
    brief: `Find credentials, tokens, private keys and connection strings committed to the
repository or its history, and any place secrets are handled unsafely (logged, passed as
build args, baked into images). Note whether anything found is still live, because a live
credential in history is an active incident, not a code-quality nit.`,
  },
  dependencies: {
    title: 'Dependency health and end-of-life exposure',
    brief: `Assess runtime, framework and library currency. Find components past end-of-life
or on a version with no upgrade path, pinned to abandoned forks, or several major versions
behind. Estimate what it would cost to get back to a supported baseline.`,
  },
  engineering: {
    title: 'Engineering and release maturity',
    brief: `Assess test coverage and test quality, CI/CD, release and rollback process,
environment parity, and observability. The question is not whether tests exist but whether
this team could ship a fix on a Friday without fear.`,
  },
  architecture: {
    title: 'Architecture and coupling',
    brief: `Assess modularity, coupling, and the presence of any single component that
everything routes through. Identify what would have to be untangled first to integrate this
system, migrate it to another cloud, or separate it from the seller's shared infrastructure.`,
  },
  keyPerson: {
    title: 'Key-person and knowledge concentration',
    brief: `Use commit history to find code owned by effectively one person, areas with no
recent contributor, and undocumented subsystems. Bus factor is a valuation input: if two
leavers take the payments engine with them, that is a retention package, not a footnote.`,
  },
  dataProtection: {
    title: 'Data protection exposure',
    brief: `Find where personal, financial or otherwise regulated data is stored, logged and
transferred, and whether deletion, export and retention are actually implemented. Undisclosed
data-protection exposure is a classic post-close surprise.`,
  },
}

const input = args ?? {}
const target = input.target ?? '.'
const dealContext = input.dealContext ?? 'no deal context supplied'
const requestedLenses = input.lenses ?? Object.keys(LENSES)

const activeLensNames = requestedLenses.filter((name) => Object.hasOwn(LENSES, name))
const skippedLenses = requestedLenses.filter((name) => !Object.hasOwn(LENSES, name))

// ── Phase 1 — scope the target so lens agents know the shape of the estate ─
const scope = await agent(
  `Profile the codebase at "${target}" for a technical due-diligence review.
Report: primary languages, approximate size, the top-level components and what each does,
build and deployment mechanism, how many distinct deployable units there are, and the age and
activity of the repository.
Do not evaluate quality — this is the map the specialist reviewers will work from.`,
  {
    label: 'profile-target',
    schema: {
      type: 'object',
      required: ['components', 'languages'],
      properties: {
        languages: { type: 'array', items: { type: 'string' } },
        components: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'purpose'],
            properties: {
              name: { type: 'string' },
              path: { type: 'string' },
              purpose: { type: 'string' },
            },
          },
        },
        deployables: { type: 'integer' },
        activitySummary: { type: 'string' },
      },
    },
  },
)

const components = scope.components ?? []

if (activeLensNames.length === 0 || components.length === 0) {
  return {
    workflow: meta.name,
    target,
    emptyScope: true,
    reason:
      activeLensNames.length === 0
        ? 'No known risk lens was requested — nothing to assess.'
        : `No components were found at "${target}" — the target may be empty or the path may be wrong.`,
    skippedLenses,
    lensResults: [],
    dealBreakers: [],
    priceAdjusting: [],
    postClose: [],
  }
}

const componentIndex = components
  .map((c) => `- ${c.name}${c.path ? ` (${c.path})` : ''}: ${c.purpose}`)
  .join('\n')

// ── Phase 2 — one lens per agent, each blind to the others ────────────────
const lensResults = await pipeline(activeLensNames, (name) => {
  const lens = LENSES[name]
  return agent(
    `You are the ${lens.title} reviewer on a technical due-diligence team assessing an
acquisition target. Deal context: ${dealContext}.

Components:
${componentIndex}

Your lens, and only your lens:
${lens.brief}

Report findings with a specific evidence location for each — a file, a manifest entry, a
commit. A finding without a location cannot be defended in a negotiation and will be dropped.
Score this lens from 1 (severe, materially affects the deal) to 5 (clean).
State explicitly what you could NOT check and why, so the deal team knows the edges of this
review.`,
    {
      label: `lens:${name}`,
      schema: {
        type: 'object',
        required: ['score', 'findings', 'notChecked'],
        properties: {
          score: { type: 'integer', minimum: 1 },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              required: ['title', 'severity', 'evidence', 'effort'],
              properties: {
                title: { type: 'string' },
                severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
                evidence: { type: 'string' },
                effort: { type: 'string', enum: ['xs', 's', 'm', 'l', 'xl'] },
                impact: { type: 'string' },
              },
            },
          },
          notChecked: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  )
})

const allFindings = []
for (let i = 0; i < activeLensNames.length; i++) {
  const name = activeLensNames[i]
  for (const finding of lensResults[i]?.findings ?? []) {
    allFindings.push({ lens: name, lensTitle: LENSES[name].title, ...finding })
  }
}

// ── Phase 3 — reconcile: one agent sees everything and classifies it ───────
const reconciliation = await agent(
  `You are writing the red-flag memo for the deal team on this acquisition.
Deal context: ${dealContext}.

Independent reviewers produced these findings. They did not see each other's work, so where
two lenses point at the same underlying problem, say so — that is a stronger signal, not two
problems.

${allFindings.map((f, i) => `${i + 1}. [${f.lens}/${f.severity}] ${f.title} — evidence: ${f.evidence} — effort: ${f.effort}`).join('\n') || '(no findings)'}

Lens scores: ${activeLensNames.map((n, i) => `${n}=${lensResults[i]?.score ?? '?'}`).join(', ')}

Classify each material finding into exactly one bucket:
- deal-breaker: would change whether to do the deal at all
- price-adjusting: quantifiable remediation cost that belongs in the negotiation
- post-close: real work, but ordinary integration cost

Write for a deal team, not an engineering standup. Answer the two questions they actually
have: what does this change about the price, and what does it change about the first 100 days.`,
  {
    label: 'reconcile-memo',
    schema: {
      type: 'object',
      required: ['headline', 'recommendation', 'dealBreakers', 'priceAdjusting', 'postClose'],
      properties: {
        headline: { type: 'string' },
        recommendation: {
          type: 'string',
          enum: ['proceed', 'proceed-with-price-adjustment', 'proceed-with-conditions', 'walk-away'],
        },
        dealBreakers: {
          type: 'array',
          items: {
            type: 'object',
            required: ['title', 'evidence', 'effort', 'why'],
            properties: {
              title: { type: 'string' },
              evidence: { type: 'string' },
              effort: { type: 'string' },
              why: { type: 'string' },
            },
          },
        },
        priceAdjusting: {
          type: 'array',
          items: {
            type: 'object',
            required: ['title', 'evidence', 'effort'],
            properties: {
              title: { type: 'string' },
              evidence: { type: 'string' },
              effort: { type: 'string' },
              indicativeCost: { type: 'string' },
            },
          },
        },
        postClose: {
          type: 'array',
          items: {
            type: 'object',
            required: ['title', 'effort'],
            properties: {
              title: { type: 'string' },
              effort: { type: 'string' },
            },
          },
        },
        firstHundredDays: { type: 'array', items: { type: 'string' } },
      },
    },
  },
)

const scores = {}
for (let i = 0; i < activeLensNames.length; i++) {
  scores[activeLensNames[i]] = lensResults[i]?.score ?? null
}

return {
  workflow: meta.name,
  target,
  dealContext,
  emptyScope: false,
  skippedLenses,
  lensesAssessed: activeLensNames,
  lensScores: scores,
  notChecked: activeLensNames.flatMap((name, i) =>
    (lensResults[i]?.notChecked ?? []).map((gap) => `${name}: ${gap}`),
  ),
  findingCount: allFindings.length,
  headline: reconciliation.headline,
  recommendation: reconciliation.recommendation,
  dealBreakers: reconciliation.dealBreakers ?? [],
  priceAdjusting: reconciliation.priceAdjusting ?? [],
  postClose: reconciliation.postClose ?? [],
  firstHundredDays: reconciliation.firstHundredDays ?? [],
  lensResults: activeLensNames.map((name, i) => ({ lens: name, ...lensResults[i] })),
}
