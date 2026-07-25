export const meta = {
  name: 'control-evidence-sweep',
  description:
    'Collect audit evidence for a control catalogue (SOC 2, ISO 27001, PCI-DSS, DORA), have every claim adversarially challenged, and return an auditor-ready evidence pack that never overstates coverage.',
}

// An evidence pack that claims a control is satisfied when it is not is worse
// than no pack: it fails the audit and costs the trust of the auditor for
// everything else in the pack. So every claim an investigator makes is handed
// to a challenger whose only job is to break it, and only surviving claims are
// reported as satisfied.

const SOC2_STARTER = [
  { id: 'CC6.1', name: 'Logical access controls restrict access to authorised users' },
  { id: 'CC6.6', name: 'Data in transit is encrypted over untrusted networks' },
  { id: 'CC6.7', name: 'Data at rest is encrypted and key material is managed' },
  { id: 'CC7.2', name: 'Security events are logged, retained and monitored' },
  { id: 'CC7.4', name: 'Incidents are detected, triaged and responded to on a defined path' },
  { id: 'CC8.1', name: 'Changes are authorised, reviewed and tested before release' },
  { id: 'CC9.2', name: 'Third-party and vendor risk is assessed and monitored' },
  { id: 'A1.2', name: 'Backups and recovery procedures are defined and exercised' },
]

const input = args ?? {}
const catalogueName = input.catalogue ?? 'SOC 2 Common Criteria (built-in starter set)'
const controls = input.controls ?? SOC2_STARTER
const period = input.period ?? 'the current audit period'

// ── Phase 1 — scope: where evidence for these controls could live ──────────
const scope = await agent(
  `Inventory the parts of this repository that could hold audit evidence for a compliance review.
Look for: authentication and authorisation code, TLS and encryption configuration, secrets
management, logging and audit-trail code, alerting and incident tooling, CI/CD and release
gates, dependency and vendor manifests, backup and disaster-recovery configuration,
infrastructure-as-code, and policy-as-code.
Report each distinct surface once, with the path and what kind of evidence it can support.
Do not evaluate compliance yet — only inventory where an auditor would look.`,
  {
    label: 'scope-evidence-surfaces',
    schema: {
      type: 'object',
      required: ['surfaces'],
      properties: {
        surfaces: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path', 'kind'],
            properties: {
              path: { type: 'string' },
              kind: { type: 'string' },
              notes: { type: 'string' },
            },
          },
        },
      },
    },
  },
)

const surfaces = scope.surfaces ?? []

if (controls.length === 0 || surfaces.length === 0) {
  return {
    workflow: meta.name,
    catalogue: catalogueName,
    period,
    emptyScope: true,
    reason:
      controls.length === 0
        ? 'No controls were supplied and the catalogue resolved to an empty set.'
        : 'No evidence surfaces were found in this repository — nothing an auditor could be pointed at.',
    controlCount: controls.length,
    surfaceCount: surfaces.length,
    satisfied: [],
    gaps: [],
    unverified: [],
  }
}

const surfaceIndex = surfaces
  .map((s) => `- ${s.path} (${s.kind})`)
  .join('\n')

// ── Phase 2 — investigate: one agent per control, hunting concrete evidence ─
const investigations = await pipeline(controls, (control) =>
  agent(
    `You are collecting audit evidence for control ${control.id}: "${control.name}".
Catalogue: ${catalogueName}. Period: ${period}.

Candidate evidence surfaces in this repository:
${surfaceIndex}

Find CONCRETE evidence that this control is implemented. Evidence means a specific file and
the specific lines or configuration that enforce the control — not a description of intent,
not a README claim, not a policy document that nothing enforces.

For each piece of evidence, state exactly what it proves and what it does NOT prove.
If you cannot find enforcing evidence, say so and name the artefact that is missing.
Do not stretch weak evidence to cover the control; a named gap is more useful than a
generous reading.`,
    {
      label: `investigate:${control.id}`,
      schema: {
        type: 'object',
        required: ['controlId', 'claims', 'missing'],
        properties: {
          controlId: { type: 'string' },
          claims: {
            type: 'array',
            items: {
              type: 'object',
              required: ['evidence', 'location', 'proves'],
              properties: {
                evidence: { type: 'string' },
                location: { type: 'string' },
                proves: { type: 'string' },
                doesNotProve: { type: 'string' },
              },
            },
          },
          missing: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  ),
)

// ── Phase 3 — challenge: an independent agent tries to break each claim ─────
const claims = []
for (let i = 0; i < controls.length; i++) {
  const control = controls[i]
  for (const claim of investigations[i]?.claims ?? []) {
    claims.push({ control, claim })
  }
}

const challenges = await pipeline(claims, ({ control, claim }) =>
  agent(
    `An auditor is about to be shown the following as evidence for control ${control.id}
("${control.name}"). Your job is to break it, not to agree with it.

Claimed evidence: ${claim.evidence}
Location: ${claim.location}
Claimed to prove: ${claim.proves}

Read the location yourself. Then answer:
- Does the evidence actually exist where claimed?
- Does it enforce the control, or merely describe it?
- Can it be bypassed, disabled, or does it cover only part of the estate?
- Would an auditor accept it as-is?

Return "refuted" if the claim does not hold, "confirmed" only if you independently verified
it enforces the control, and "unverified" if you could not check it. Never return "confirmed"
to be agreeable.`,
    {
      label: `challenge:${control.id}`,
      schema: {
        type: 'object',
        required: ['verdict', 'reason'],
        properties: {
          verdict: { type: 'string', enum: ['confirmed', 'refuted', 'unverified'] },
          reason: { type: 'string' },
          residualRisk: { type: 'string' },
        },
      },
    },
  ),
)

// ── Phase 4 — assemble the pack from verified data, in the script ──────────
const byControl = new Map(
  controls.map((control) => [control.id, { control, confirmed: [], refuted: [], unverified: [] }]),
)

for (let i = 0; i < claims.length; i++) {
  const { control, claim } = claims[i]
  const verdict = challenges[i]?.verdict ?? 'unverified'
  const entry = {
    evidence: claim.evidence,
    location: claim.location,
    proves: claim.proves,
    reason: challenges[i]?.reason ?? 'No challenge result returned.',
  }
  const bucket = byControl.get(control.id)
  if (!bucket) continue
  if (verdict === 'confirmed') bucket.confirmed.push(entry)
  else if (verdict === 'refuted') bucket.refuted.push(entry)
  else bucket.unverified.push(entry)
}

const satisfied = []
const gaps = []
const unverified = []

for (let i = 0; i < controls.length; i++) {
  const control = controls[i]
  const bucket = byControl.get(control.id)
  const missing = investigations[i]?.missing ?? []

  if (bucket.confirmed.length > 0) {
    satisfied.push({ ...control, evidence: bucket.confirmed })
  } else if (bucket.unverified.length > 0 && bucket.refuted.length === 0) {
    unverified.push({ ...control, blocked: bucket.unverified })
  } else {
    gaps.push({
      ...control,
      missing,
      refutedClaims: bucket.refuted,
      unverifiedClaims: bucket.unverified,
    })
  }
}

// ── Phase 5 — narrative for the control owner who has to sign this ─────────
const summary = await agent(
  `Write the cover summary for a compliance evidence pack.
Catalogue: ${catalogueName}. Period: ${period}.
Controls with verified evidence: ${satisfied.length}.
Controls with gaps: ${gaps.length}.
Controls that could not be verified: ${unverified.length}.

Gap controls: ${gaps.map((g) => `${g.id} (${g.name})`).join(', ') || 'none'}.
Unverified controls: ${unverified.map((u) => `${u.id} (${u.name})`).join(', ') || 'none'}.

Write for the control owner who has to sign this pack before it reaches an auditor. Be direct
about what is not covered. Recommend the smallest set of changes that would close the gaps,
ordered by how likely each gap is to be probed in an audit.`,
  {
    label: 'summarise-pack',
    schema: {
      type: 'object',
      required: ['headline', 'readiness', 'recommendations'],
      properties: {
        headline: { type: 'string' },
        readiness: { type: 'string', enum: ['ready', 'ready-with-caveats', 'not-ready'] },
        recommendations: { type: 'array', items: { type: 'string' } },
      },
    },
  },
)

return {
  workflow: meta.name,
  catalogue: catalogueName,
  period,
  emptyScope: false,
  surfaceCount: surfaces.length,
  controlCount: controls.length,
  headline: summary.headline,
  readiness: summary.readiness,
  recommendations: summary.recommendations ?? [],
  coverage: {
    satisfied: satisfied.length,
    gaps: gaps.length,
    unverified: unverified.length,
  },
  satisfied,
  gaps,
  unverified,
}
