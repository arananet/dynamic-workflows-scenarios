// Shared test utilities for driving workflow scripts through the harness.

import { fakeFromSchema, runWorkflowFile } from './harness.js'

export const WORKFLOW_DIR = new URL('../.claude/workflows/', import.meta.url).pathname

export function workflowPath(name) {
  return `${WORKFLOW_DIR}${name}.js`
}

/** Run a scenario by name. */
export function run(name, options) {
  return runWorkflowFile(workflowPath(name), options)
}

/**
 * Like `fakeFromSchema`, but every array comes back empty — used to simulate a
 * scoping phase that found nothing.
 */
export function emptyFromSchema(schema, path = 'value') {
  if (!schema || typeof schema !== 'object') return path
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type
  if (type === 'array') return []
  if (type === 'object') {
    const properties = schema.properties ?? {}
    const keys = new Set([...Object.keys(properties), ...(schema.required ?? [])])
    const out = {}
    for (const key of keys) {
      out[key] = emptyFromSchema(properties[key] ?? { type: 'string' }, `${path}.${key}`)
    }
    return out
  }
  return fakeFromSchema(schema, path)
}

/**
 * Like `fakeFromSchema`, but every array comes back with `count` items — used
 * to check that a scenario's fan-out cap holds against an oversized inventory.
 */
export function bigFromSchema(schema, count, path = 'value') {
  if (!schema || typeof schema !== 'object') return path
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type
  if (type === 'array') {
    const items = schema.items ?? { type: 'string' }
    return Array.from({ length: count }, (_, i) => bigFromSchema(items, count, `${path}[${i}]`))
  }
  if (type === 'object') {
    const properties = schema.properties ?? {}
    const keys = new Set([...Object.keys(properties), ...(schema.required ?? [])])
    const out = {}
    for (const key of keys) {
      out[key] = bigFromSchema(properties[key] ?? { type: 'string' }, count, `${path}.${key}`)
    }
    return out
  }
  return fakeFromSchema(schema, path)
}

/** A `respond` function that only answers the first agent call (the scoping phase). */
export function scopingReturns(transform) {
  return (call) => (call.index === 0 ? transform(call.schema) : undefined)
}

/**
 * Build a `respond` function from `{ 'label-prefix': value | fn }` entries.
 * Unmatched calls fall through to the schema-derived stub.
 */
export function byLabel(handlers) {
  const entries = Object.entries(handlers)
  return (call) => {
    if (!call.label) return undefined
    for (const [prefix, handler] of entries) {
      if (call.label === prefix || call.label.startsWith(prefix)) {
        return typeof handler === 'function' ? handler(call) : handler
      }
    }
    return undefined
  }
}

/** Agent calls whose label starts with `prefix`, in order. */
export function callsLabelled(transcript, prefix) {
  return transcript.filter((call) => call.label?.startsWith(prefix))
}

/** Index of the first agent call whose label starts with `prefix`, or -1. */
export function firstIndexOf(transcript, prefix) {
  return transcript.findIndex((call) => call.label?.startsWith(prefix))
}

/** Every string leaf reachable from a value — used for "no empty field" assertions. */
export function assertNonEmptyFields(t, object, fields, context) {
  for (const field of fields) {
    const value = object[field]
    const ok = Array.isArray(value) ? value.length > 0 : typeof value === 'string' ? value.length > 0 : value != null
    t.assert.ok(ok, `${context}: expected non-empty "${field}", got ${JSON.stringify(value)}`)
  }
}
