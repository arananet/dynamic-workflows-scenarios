import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  MAX_AGENTS_PER_RUN,
  compileWorkflow,
  fakeFromSchema,
  loadWorkflow,
  runWorkflow,
} from './harness.js'

const FIXTURE = new URL('./fixtures/sample-workflow.js', import.meta.url).pathname

test('loadWorkflow recovers meta and the return value, and leaves the file untouched', async () => {
  const before = await readFile(FIXTURE, 'utf8')
  const { fn } = await loadWorkflow(FIXTURE)
  const { meta, result } = await runWorkflow(fn, { args: { hello: 'world' } })
  const after = await readFile(FIXTURE, 'utf8')

  assert.strictEqual(meta.name, 'sample-workflow')
  assert.ok(meta.description.length > 0)
  assert.strictEqual(result.workflow, 'sample-workflow')
  assert.deepStrictEqual(result.args, { hello: 'world' })
  assert.strictEqual(after, before, 'the harness must not rewrite the script on disk')
})

test('compileWorkflow rejects a script with no meta export', () => {
  assert.throws(() => compileWorkflow('return 1'), /must contain `export const meta/)
})

test('fakeFromSchema honours required keys, types, enums and array minimums', () => {
  const value = fakeFromSchema({
    type: 'object',
    required: ['id', 'missingFromProperties'],
    properties: {
      id: { type: 'string' },
      count: { type: 'integer', minimum: 7 },
      ready: { type: 'boolean' },
      verdict: { type: 'string', enum: ['confirmed', 'refuted'] },
      nested: {
        type: 'object',
        required: ['deep'],
        properties: { deep: { type: 'string' } },
      },
      items: { type: 'array', items: { type: 'string' } },
      manyItems: { type: 'array', minItems: 3, items: { type: 'number' } },
    },
  })

  assert.strictEqual(typeof value.id, 'string')
  assert.ok(value.id.length > 0)
  assert.strictEqual(typeof value.missingFromProperties, 'string')
  assert.strictEqual(value.count, 7)
  assert.strictEqual(value.ready, true)
  assert.strictEqual(value.verdict, 'confirmed', 'enum resolves to the first allowed value')
  assert.strictEqual(typeof value.nested.deep, 'string')
  assert.strictEqual(value.items.length, 1, 'arrays are never empty')
  assert.strictEqual(value.manyItems.length, 3, 'minItems is honoured')
})

test('fakeFromSchema prefers const and default over generated values', () => {
  assert.strictEqual(fakeFromSchema({ const: 'fixed' }), 'fixed')
  assert.strictEqual(fakeFromSchema({ type: 'string', default: 'preset' }), 'preset')
})

test('runWorkflow records prompt, label and schema for every agent call, in order', async () => {
  const fn = compileWorkflow(`export const meta = { name: 'x' }
await agent('first', { label: 'a', schema: { type: 'object', properties: {} } })
await agent('second', { label: 'b' })
return 'done'`)

  const { transcript, agentCount } = await runWorkflow(fn)

  assert.strictEqual(agentCount, 2)
  assert.deepStrictEqual(
    transcript.map((call) => [call.prompt, call.label]),
    [
      ['first', 'a'],
      ['second', 'b'],
    ],
  )
  assert.ok(transcript[0].schema, 'schema is captured when supplied')
  assert.strictEqual(transcript[1].schema, null, 'schema is null when omitted')
})

test('pipeline invokes the mapper once per item and preserves input order', async () => {
  const fn = compileWorkflow(`export const meta = { name: 'x' }
const out = await pipeline(['a', 'b', 'c'], (item, i) => \`\${i}:\${item}\`)
return out`)

  const { result, pipelines } = await runWorkflow(fn)

  assert.deepStrictEqual(result, ['0:a', '1:b', '2:c'])
  assert.strictEqual(pipelines.length, 1)
  assert.strictEqual(pipelines[0].size, 3)
})

test('pipeline over an empty list returns [] without invoking the mapper', async () => {
  const fn = compileWorkflow(`export const meta = { name: 'x' }
return await pipeline(args.items, (item) => { args.seen.push(item); return item })`)

  const seen = []
  const { result, pipelines } = await runWorkflow(fn, { args: { items: [], seen } })

  assert.deepStrictEqual(result, [])
  assert.strictEqual(seen.length, 0, 'the mapper must not run for an empty list')
  assert.strictEqual(pipelines[0].size, 0)
})

test('agent calls inside a pipeline are tagged with that pipeline group', async () => {
  const fn = compileWorkflow(`export const meta = { name: 'x' }
await agent('solo', { label: 'solo' })
await pipeline(['a', 'b'], (item) => agent('work ' + item, { label: 'work:' + item }))
return 'ok'`)

  const { transcript } = await runWorkflow(fn)

  assert.strictEqual(transcript[0].group, null)
  assert.strictEqual(transcript[1].group, 0)
  assert.strictEqual(transcript[2].group, 0)
})

test('respond overrides the schema stub, and undefined falls through to it', async () => {
  const fn = compileWorkflow(`export const meta = { name: 'x' }
const a = await agent('one', { label: 'override', schema: { type: 'object', required: ['v'], properties: { v: { type: 'string' } } } })
const b = await agent('two', { label: 'fallthrough', schema: { type: 'object', required: ['v'], properties: { v: { type: 'string' } } } })
return [a, b]`)

  const { result } = await runWorkflow(fn, {
    respond: (call) => (call.label === 'override' ? { v: 'forced' } : undefined),
  })

  assert.strictEqual(result[0].v, 'forced')
  assert.strictEqual(typeof result[1].v, 'string')
  assert.notStrictEqual(result[1].v, 'forced')
})

test('the harness throws rather than letting a run exceed the agent cap', async () => {
  const fn = compileWorkflow(`export const meta = { name: 'x' }
for (let i = 0; i <= ${MAX_AGENTS_PER_RUN}; i++) await agent('spin ' + i)
return 'never'`)

  await assert.rejects(runWorkflow(fn), new RegExp(`${MAX_AGENTS_PER_RUN}-agent runtime cap`))
})
