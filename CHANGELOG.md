# Changelog

All notable changes to `dynamic-workflows-scenarios` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!--
Guidelines:
- Add a new entry under `## [Unreleased]` as you work — no batching up for release day.
- Group entries under: Added, Changed, Deprecated, Removed, Fixed, Security.
- Reference the spec slug and PR number:  "Added dark mode (spec: dark-mode, #42)".
- On release, rename `[Unreleased]` to the new version with the release date,
  and open a fresh `[Unreleased]` section at the top.
- The release-drafter workflow auto-populates draft release notes from PRs —
  keep PR titles tidy so they flow straight into here.
-->

## [Unreleased]

### Added
- **Eight enterprise dynamic-workflow scenarios** in `.claude/workflows/`, each a
  self-contained orchestration script that becomes a slash command:
  - `control-evidence-sweep` — adversarially verified audit evidence pack (spec: regulated-compliance-scenarios)
  - `reg-change-impact` — regulatory change decomposed into a staffable remediation backlog (spec: regulated-compliance-scenarios)
  - `ma-code-diligence` — seven blind risk lenses reconciled into a red-flag memo (spec: modernization-ma-scenarios)
  - `strangler-fig-plan` — three rival decomposition plans, cross-critiqued and scored (spec: modernization-ma-scenarios)
  - `cve-blast-radius` — reachability triage with challenged verdicts (spec: security-incident-scenarios)
  - `incident-forensics` — competing causal hypotheses, cross-examined (spec: security-incident-scenarios)
  - `cloud-cost-hotspots` — cost sweep with independently re-derived saving estimates (spec: platform-sre-scenarios)
  - `slo-readiness-audit` — readiness scorecard with verified passes, ranked by blast radius (spec: platform-sre-scenarios)
- `tests/harness.js` — offline emulation of the dynamic-workflow runtime's scripting
  surface (`meta`, `agent`, `pipeline`, `args`), so scenarios are testable without
  spending tokens (spec: workflow-library-harness)
- `tests/` — 107 tests: harness unit tests, a library-wide conformance suite that
  picks up any new scenario automatically, and per-domain behavioural tests
- `docs/SCENARIOS.md` — business brief, arguments, output shape, cost and limits per scenario
- `package.json` — Node's built-in test runner only; no dependencies

### Changed
- `README.md` rewritten to describe this project rather than the OpenSpec template
- `.openspec/config.yaml` and `.openspec/defaults.yaml` populated during onboarding
  (project, owner `arananet`, tech stack, `test_command: npm test`, default roles)
- `.github/CODEOWNERS` set to `@arananet` throughout — personal repository, no org team

### Removed
- Template-internal design specs, via `scripts/cleanup-template-specs`

### Security
- Twenty non-required GitHub Actions workflows reduced to `workflow_dispatch`-only
  (CodeQL, Scorecard, SBOM, release, container/license/secret scanning, DCO,
  dependency review, doc drift, stale, labeler, repo-init, spec bootstrap,
  spec AI review, spec metrics, issue autofix, template smoke test, Dependabot
  auto-merge, release drafter). Original triggers are retained commented-out
  immediately above the replacement so any workflow can be restored in one edit.
  `OpenSpec PR Check` and `Lint` still run on every push and pull request.
- Roles section in spec templates (`implementer`, `reviewer`, `qa`, `product_owner`) for per-spec responsibility assignment
- `roles.default_*` block in `.openspec/config.yaml` and `.openspec/defaults.yaml` for repo-wide default role assignments
- `scripts/openspec scaffold` now reads `roles.default_*` from config and pre-fills new specs
- Onboarding interview (`.openspec/onboarding.yaml`) prompts for default implementer / reviewer / qa / product_owner
- `Makefile` with convenience targets: `check`, `scaffold`, `scaffold-bug`, `test`, `status`, `setup`, `cleanup-template-specs`, `apply-branch-protection`
- `scripts/cleanup-template-specs` removes the template's internal design specs from a fresh fork
- `.vscode/settings.json` and `.vscode/extensions.json` with YAML schemas, markdownlint config, and recommended extensions
- `renovate.json.example` as an opt-in alternative to `dependabot.yml`
- Spec lifecycle state diagram in [`docs/OPENSPEC.md`](docs/OPENSPEC.md)
- **Enterprise hardening:**
  - `.github/workflows/license-scan.yml` + `.licenses/policy.yaml` — ScanCode-based OSS license enforcement
  - `.github/workflows/container-scan.yml` — Hadolint + Trivy scanning, auto-skips when no Dockerfile present
  - `.github/workflows/spec-metrics.yml` — weekly DORA-style report on spec status, role coverage, PR→spec link rate
  - `docs/branch-protection-ruleset.json` + `scripts/apply-branch-protection` — one-command branch protection bootstrap
  - `SECRETS.md` — secrets-management policy with rotation cadences and incident response
  - PR template extended with accessibility, privacy / data-handling, and security checklists
- `CONTRIBUTING.md` documents the `roles` block in the spec workflow
- `CLAUDE.md` Step 5 now instructs Claude to walk users through `roles` during scaffolding
- `CLAUDE.md` Step 6 now instructs Claude to clean up template-internal specs

### Changed
-

### Deprecated
-

### Removed
-

### Fixed
-

### Security
-

---

## [0.1.0] — YYYY-MM-DD

### Added
- Initial release.

[Unreleased]: https://github.com/arananet/dynamic-workflows-scenarios/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/arananet/dynamic-workflows-scenarios/releases/tag/v0.1.0
