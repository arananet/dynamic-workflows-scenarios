export const meta = {
  name: 'sample-workflow',
  description: 'Fixture used by the harness unit tests. Not a real scenario.',
}

const scope = await agent('list things', {
  label: 'scope',
  schema: {
    type: 'object',
    required: ['things'],
    properties: { things: { type: 'array', items: { type: 'string' } } },
  },
})

const seen = await pipeline(scope.things, (thing, index) => `${index}:${thing}`)

return { workflow: meta.name, args: args ?? null, seen }
