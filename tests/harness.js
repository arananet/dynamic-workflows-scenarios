// Offline emulation of the Claude Code dynamic-workflow runtime.
//
// A workflow script is not a valid ES module: it combines `export const meta`
// with top-level `await` AND a top-level `return`, and it reads `agent`,
// `pipeline` and `args` as globals the runtime injects. So it cannot simply be
// imported. This harness compiles a script the way the runtime does — one
// token rewrite, then the AsyncFunction constructor — and runs it against
// stubbed agents that synthesise schema-conformant results.
//
// What this buys: a scenario's real control flow (fan-out sizing, caps, empty
// guards, verdict arithmetic, result shape) is exercised in milliseconds for
// zero tokens. What it does not buy: any signal about whether the prompts
// elicit good answers from real subagents. That needs a live run.

import { readFile } from 'node:fs/promises'

/** Runtime cap: total agents per run. */
export const MAX_AGENTS_PER_RUN = 1000
/** Runtime cap: concurrent agents. */
export const MAX_CONCURRENCY = 16

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const META_EXPORT = /export\s+const\s+meta\s*=/

/**
 * Compile a workflow script into a callable.
 *
 * The only transformation is rewriting the `export const meta =` token so the
 * exported object is also captured on a context object — everything else,
 * including top-level await and the top-level return, is preserved verbatim.
 * The file on disk is never modified.
 */
export function compileWorkflow(source) {
  if (!META_EXPORT.test(source)) {
    throw new Error('workflow script must contain `export const meta = { ... }`')
  }
  const body = source.replace(META_EXPORT, 'const meta = __ctx.meta =')
  return new AsyncFunction('__ctx', 'agent', 'pipeline', 'args', body)
}

/** Read a workflow script from disk and compile it. */
export async function loadWorkflow(path) {
  const source = await readFile(path, 'utf8')
  return { source, fn: compileWorkflow(source) }
}

/**
 * Synthesise a value that conforms to a JSON schema, so a script's downstream
 * property access succeeds. Arrays always get at least one element and objects
 * always get every declared and required key — an under-populated stub would
 * make a script look robust when it is not.
 */
export function fakeFromSchema(schema, path = 'value') {
  if (!schema || typeof schema !== 'object') return path

  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  if (Object.hasOwn(schema, 'const')) return schema.const
  if (Object.hasOwn(schema, 'default')) return schema.default

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type

  switch (type) {
    case 'object': {
      const properties = schema.properties ?? {}
      const keys = new Set([...Object.keys(properties), ...(schema.required ?? [])])
      const out = {}
      for (const key of keys) {
        out[key] = fakeFromSchema(properties[key] ?? { type: 'string' }, `${path}.${key}`)
      }
      return out
    }
    case 'array': {
      const count = Math.max(1, schema.minItems ?? 1)
      const items = schema.items ?? { type: 'string' }
      return Array.from({ length: count }, (_, i) => fakeFromSchema(items, `${path}[${i}]`))
    }
    case 'integer':
    case 'number':
      return schema.minimum ?? 1
    case 'boolean':
      return true
    case 'null':
      return null
    default:
      return path
  }
}

/**
 * Run a compiled workflow against stubbed agents.
 *
 * `respond(call)` may return a replacement result for any agent call; returning
 * `undefined` falls through to the schema-derived stub. That is how a test
 * forces, say, every verification verdict to `refuted` and then asserts what
 * the script does with it.
 *
 * `pipeline` runs its mapper sequentially: real concurrency would make the
 * transcript non-deterministic, and the thing under test is the orchestration
 * shape, not the scheduler.
 */
export async function runWorkflow(fn, { args, respond } = {}) {
  const transcript = []
  const pipelines = []
  let group = null

  const agent = async (prompt, options = {}) => {
    if (transcript.length >= MAX_AGENTS_PER_RUN) {
      throw new Error(`workflow exceeded the ${MAX_AGENTS_PER_RUN}-agent runtime cap`)
    }
    const call = {
      index: transcript.length,
      prompt,
      label: options.label ?? null,
      schema: options.schema ?? null,
      model: options.model ?? null,
      group,
    }
    transcript.push(call)

    const override = respond ? respond(call) : undefined
    call.result = override !== undefined
      ? override
      : call.schema
        ? fakeFromSchema(call.schema, `agent${call.index}`)
        : `stub result for agent ${call.index}`
    return call.result
  }

  const pipeline = async (items, mapper) => {
    const list = Array.from(items ?? [])
    const record = { index: pipelines.length, size: list.length, concurrency: MAX_CONCURRENCY }
    pipelines.push(record)

    const previous = group
    group = record.index
    try {
      const results = []
      for (let i = 0; i < list.length; i++) results.push(await mapper(list[i], i))
      return results
    } finally {
      group = previous
    }
  }

  const ctx = {}
  const result = await fn(ctx, agent, pipeline, args)
  return { meta: ctx.meta, result, transcript, pipelines, agentCount: transcript.length }
}

/** Convenience: load, compile and run in one call. */
export async function runWorkflowFile(path, options) {
  const { fn } = await loadWorkflow(path)
  return runWorkflow(fn, options)
}

/** Agent calls issued outside any pipeline, in order. */
export function soloCalls(transcript) {
  return transcript.filter((call) => call.group === null)
}

/** Agent calls issued inside the nth pipeline, in order. */
export function pipelineCalls(transcript, index) {
  return transcript.filter((call) => call.group === index)
}
