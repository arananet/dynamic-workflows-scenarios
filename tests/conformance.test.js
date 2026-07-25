// Library-wide contract. Every scenario in `.claude/workflows/` must satisfy
// these, so a new scenario is wired into CI the moment its file lands.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { MAX_AGENTS_PER_RUN, loadWorkflow } from './harness.js'
import { WORKFLOW_DIR, bigFromSchema, emptyFromSchema, run, scopingReturns } from './helpers.js'

const names = (await readdir(WORKFLOW_DIR))
  .filter((file) => file.endsWith('.js'))
  .map((file) => file.replace(/\.js$/, ''))
  .sort()

test('the workflow directory is not empty', () => {
  assert.ok(names.length > 0, 'expected at least one scenario in .claude/workflows/')
})

for (const name of names) {
  test(`${name}: meta.name matches the filename and the description is real`, async () => {
    const { fn } = await loadWorkflow(`${WORKFLOW_DIR}${name}.js`)
    const { meta } = await run(name)

    assert.ok(fn, 'script compiles')
    assert.strictEqual(meta?.name, name, 'meta.name must equal the filename stem — it is the slash command')
    assert.strictEqual(typeof meta?.description, 'string')
    assert.ok(meta.description.length > 40, 'description is what a user sees in / autocomplete')
  })

  test(`${name}: runs to completion with args undefined`, async () => {
    const { result, agentCount, transcript } = await run(name)

    assert.notStrictEqual(result, undefined, 'a workflow must return its report')
    assert.strictEqual(typeof result, 'object')
    assert.strictEqual(result.workflow, name, 'the result identifies which workflow produced it')
    assert.ok(agentCount >= 1, 'a workflow that spawns no agent should not be a workflow')
    assert.ok(transcript.every((call) => typeof call.prompt === 'string' && call.prompt.trim().length > 0))
  })

  test(`${name}: reports an empty scope instead of throwing when scoping finds nothing`, async () => {
    const { result } = await run(name, { respond: scopingReturns(emptyFromSchema) })

    assert.strictEqual(result.emptyScope, true, 'an empty scope must be reported, not inferred from a blank report')
    assert.strictEqual(typeof result.reason, 'string')
    assert.ok(result.reason.length > 0, 'an empty-scope result must say why it is empty')
  })

  test(`${name}: stays under the ${MAX_AGENTS_PER_RUN}-agent cap on an oversized inventory`, async () => {
    const { agentCount, result } = await run(name, {
      respond: scopingReturns((schema) => bigFromSchema(schema, 500)),
    })

    assert.ok(
      agentCount < MAX_AGENTS_PER_RUN,
      `${name} spawned ${agentCount} agents against a 500-item inventory — it needs a fan-out cap`,
    )
    assert.notStrictEqual(result, undefined)
  })

  test(`${name}: every agent call carries a label`, async () => {
    const { transcript } = await run(name)

    const unlabelled = transcript.filter((call) => !call.label)
    assert.strictEqual(
      unlabelled.length,
      0,
      `labels are what the /workflows progress view shows; unlabelled prompts: ${unlabelled.map((c) => c.prompt.slice(0, 40)).join(' | ')}`,
    )
  })
}
