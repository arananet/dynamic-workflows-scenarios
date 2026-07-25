export const meta = {
  name: 'cloud-cost-hotspots',
  description:
    'Sweep infrastructure-as-code and application code for the patterns that actually move a cloud bill, have every saving estimate independently re-derived, and return a ranked backlog whose headline number is defensible in a finance meeting.',
}

// FinOps programmes die on the first inflated saving claim. An LLM asked to
// estimate a saving will happily produce a confident number, so every estimate
// here is re-derived by a second agent from the same evidence, and only
// confirmed and adjusted figures reach the headline total. The number you can
// repeat to a CFO is worth more than the number that sounds best.

const COST_PATTERNS = [
  'Over-provisioned compute: instance sizes, replica counts and autoscaling floors far above observed need',
  'Unbounded retention: logs, metrics, traces, backups and object storage with no lifecycle or expiry policy',
  'Cross-zone and egress chatter: traffic crossing availability zones, regions or the internet where it need not',
  'Always-on non-production: dev, staging and preview environments running 168 hours a week for a 40-hour team',
  'Metered-service N+1: per-item calls to a per-request-priced API, database or managed service inside a loop',
  'Orphaned resources: volumes, IPs, snapshots, load balancers and registries no longer referenced by anything',
  'Storage class mismatch: hot storage tiers holding data that is never read after the first day',
  'Oversized managed services: cluster, cache and database tiers picked for a launch that never came',
]

const input = args ?? {}
const root = input.root ?? '.'
const currency = input.currency ?? 'USD'
const maxSurfaces = Math.max(1, input.maxSurfaces ?? 80)

// ── Phase 1 — discover the surfaces worth sweeping ────────────────────────
const discovery = await agent(
  `Inventory every surface under "${root}" where cloud cost is decided.

Include: Terraform, CloudFormation, Pulumi, CDK and other IaC; Kubernetes manifests, Helm
charts and operator configs; serverless and container definitions; CI/CD pipeline definitions
(build minutes are a bill too); database, cache and queue configuration; logging, metrics and
tracing configuration; and application code that calls metered services in a hot path.

Group by deployable unit or module rather than by file where that makes sense — one agent will
be assigned per surface. Rank by likely cost impact, largest first: only the top ${maxSurfaces}
surfaces will be swept.`,
  {
    label: 'discover-surfaces',
    schema: {
      type: 'object',
      required: ['surfaces'],
      properties: {
        surfaces: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'path', 'kind'],
            properties: {
              name: { type: 'string' },
              path: { type: 'string' },
              kind: {
                type: 'string',
                enum: ['iac', 'kubernetes', 'serverless', 'ci', 'datastore', 'observability', 'application'],
              },
              provider: { type: 'string' },
              rationale: { type: 'string' },
            },
          },
        },
      },
    },
  },
)

const allSurfaces = discovery.surfaces ?? []
const surfaces = allSurfaces.slice(0, maxSurfaces)

if (surfaces.length === 0) {
  return {
    workflow: meta.name,
    root,
    currency,
    emptyScope: true,
    reason: `No infrastructure, configuration or metered-service surfaces were found under "${root}". If this repository holds only application logic, point the workflow at the infrastructure repository instead.`,
    surfacesConsidered: 0,
    truncated: 0,
    headlineSaving: { low: 0, high: 0, currency },
    backlog: [],
    refuted: [],
  }
}

// ── Phase 2 — sweep, one agent per surface ────────────────────────────────
const sweeps = await pipeline(surfaces, (surface) =>
  agent(
    `Find cost hotspots in "${surface.name}" (${surface.kind}${surface.provider ? `, ${surface.provider}` : ''})${surface.path ? ` at ${surface.path}` : ''}.

Look for these patterns specifically:
${COST_PATTERNS.map((p, i) => `${i + 1}. ${p}`).join('\n')}

For each hotspot: name the exact file and setting, say what it costs and why, and give the
change that would fix it. Estimate the annual saving as a LOW-HIGH band in ${currency}, and
state the assumptions the band rests on — instance pricing, retention volume, hours saved,
request rate. A second reviewer will re-derive your figure from those assumptions, so make
them explicit and defensible.

Do not report a hotspot you cannot cost. Do not report style opinions. If the configuration
is already sensible, say so and report nothing — a clean surface is a useful result.`,
    {
      label: `sweep:${surface.name}`,
      schema: {
        type: 'object',
        required: ['hotspots'],
        properties: {
          hotspots: {
            type: 'array',
            items: {
              type: 'object',
              required: ['pattern', 'location', 'change', 'annualLow', 'annualHigh', 'assumptions'],
              properties: {
                pattern: { type: 'string' },
                location: { type: 'string' },
                change: { type: 'string' },
                annualLow: { type: 'number', minimum: 0 },
                annualHigh: { type: 'number', minimum: 0 },
                assumptions: { type: 'array', items: { type: 'string' } },
                risk: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
              },
            },
          },
        },
      },
    },
  ),
)

const claims = []
for (let i = 0; i < surfaces.length; i++) {
  for (const hotspot of sweeps[i]?.hotspots ?? []) {
    claims.push({ surface: surfaces[i], hotspot })
  }
}

if (claims.length === 0) {
  return {
    workflow: meta.name,
    root,
    currency,
    emptyScope: false,
    surfacesConsidered: allSurfaces.length,
    surfacesSwept: surfaces.length,
    truncated: Math.max(0, allSurfaces.length - surfaces.length),
    headline: 'No costed hotspots were found across the swept surfaces.',
    headlineSaving: { low: 0, high: 0, currency },
    backlog: [],
    refuted: [],
  }
}

// ── Phase 3 — independently re-derive every saving estimate ───────────────
const verifications = await pipeline(claims, ({ surface, hotspot }) =>
  agent(
    `Re-derive a cloud saving estimate from scratch. Someone will repeat this number to a
finance team, so an inflated figure is worse than no figure.

Surface: ${surface.name}${surface.path ? ` (${surface.path})` : ''}
Claimed hotspot: ${hotspot.pattern}
Location: ${hotspot.location}
Proposed change: ${hotspot.change}
Claimed annual saving: ${hotspot.annualLow}-${hotspot.annualHigh} ${currency}
Assumptions the claim rests on:
${(hotspot.assumptions ?? []).map((a) => `- ${a}`).join('\n') || '- (none stated)'}

Read the location yourself. Then:
- Does the hotspot actually exist as described, or was the configuration misread?
- Are the assumptions plausible, or does the estimate assume usage the code contradicts?
- Would the proposed change actually work, or does something else depend on the current setting?
- Does the change carry a reliability or compliance cost that offsets the saving?

Return "confirmed" if your own figure lands inside their band, "adjusted" with your own band if
it does not, and "refuted" if the hotspot is not real or the change is not safe to make. Being
unable to find the location is a refutation, not a confirmation.`,
    {
      label: `verify:${surface.name}`,
      schema: {
        type: 'object',
        required: ['verdict', 'reason'],
        properties: {
          verdict: { type: 'string', enum: ['confirmed', 'adjusted', 'refuted'] },
          reason: { type: 'string' },
          annualLow: { type: 'number', minimum: 0 },
          annualHigh: { type: 'number', minimum: 0 },
          offsettingCost: { type: 'string' },
        },
      },
    },
  ),
)

// ── Phase 4 — assemble a backlog whose headline total is defensible ───────
const backlog = []
const refuted = []
let low = 0
let high = 0

for (let i = 0; i < claims.length; i++) {
  const { surface, hotspot } = claims[i]
  const check = verifications[i] ?? {}
  const entry = {
    surface: surface.name,
    kind: surface.kind,
    location: hotspot.location,
    pattern: hotspot.pattern,
    change: hotspot.change,
    risk: hotspot.risk ?? 'low',
    claimed: { low: hotspot.annualLow ?? 0, high: hotspot.annualHigh ?? 0 },
    reason: check.reason ?? 'No verification result returned.',
  }

  if (check.verdict === 'refuted') {
    refuted.push({ ...entry, confidence: 'refuted', savingBand: { low: 0, high: 0, currency } })
    continue
  }

  const useOwn = check.verdict === 'adjusted' && typeof check.annualLow === 'number'
  const band = useOwn
    ? { low: check.annualLow, high: check.annualHigh ?? check.annualLow, currency }
    : { low: hotspot.annualLow ?? 0, high: hotspot.annualHigh ?? 0, currency }

  low += band.low
  high += band.high
  backlog.push({
    ...entry,
    confidence: check.verdict === 'confirmed' ? 'confirmed' : 'adjusted',
    savingBand: band,
    offsettingCost: check.offsettingCost ?? null,
  })
}

backlog.sort((a, b) => b.savingBand.high - a.savingBand.high)

// ── Phase 5 — the slide that goes to the engineering-finance review ───────
const summary = await agent(
  `Summarise a cloud cost review for a joint engineering and finance audience.

Surfaces swept: ${surfaces.length} of ${allSurfaces.length} discovered.
Hotspots claimed: ${claims.length}. Survived independent re-estimation: ${backlog.length}.
Refuted on review: ${refuted.length}.
Defensible annual saving: ${Math.round(low)}-${Math.round(high)} ${currency}.

Top opportunities:
${backlog.slice(0, 10).map((b) => `- ${b.surface}: ${b.pattern} — ${Math.round(b.savingBand.low)}-${Math.round(b.savingBand.high)} ${currency} (${b.confidence}, ${b.risk} risk) — ${b.change}`).join('\n')}

Say which items are safe to do this sprint, which need a change window, and which trade
reliability for cost and should be a conscious decision rather than a default. Be explicit that
these figures are derived from code and configuration, not from a billing API, and should be
confirmed against real billing data before anyone commits to them in a business case.`,
  {
    label: 'summarise-savings',
    schema: {
      type: 'object',
      required: ['headline', 'thisSprint', 'needsChangeWindow'],
      properties: {
        headline: { type: 'string' },
        thisSprint: { type: 'array', items: { type: 'string' } },
        needsChangeWindow: { type: 'array', items: { type: 'string' } },
        reliabilityTradeoffs: { type: 'array', items: { type: 'string' } },
      },
    },
  },
)

return {
  workflow: meta.name,
  root,
  currency,
  emptyScope: false,
  surfacesConsidered: allSurfaces.length,
  surfacesSwept: surfaces.length,
  truncated: Math.max(0, allSurfaces.length - surfaces.length),
  headline: summary.headline,
  headlineSaving: { low: Math.round(low), high: Math.round(high), currency },
  caveat:
    'Estimates are derived from code and configuration, not from billing data. Confirm the top items against real invoices before committing to them.',
  claimed: claims.length,
  survived: backlog.length,
  thisSprint: summary.thisSprint ?? [],
  needsChangeWindow: summary.needsChangeWindow ?? [],
  reliabilityTradeoffs: summary.reliabilityTradeoffs ?? [],
  backlog,
  refuted,
}
