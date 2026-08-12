import { createInterface } from 'node:readline'
import type { PendingRequest } from '../engine/suspend.js'

interface JsonSchemaProp {
  type?: string
  enum?: string[]
}

interface ObjectJsonSchema {
  properties?: Record<string, JsonSchemaProp>
  required?: string[]
}

/** One question in, one line of answer out — an interface rather than raw
 * streams so tests can script answers without racing readline's own
 * line-buffering (a real terminal never has the next answer ready before
 * its question is asked; a pre-filled fake stream does, and readline's
 * `question()` promise can miss a `line` event that fires before it's
 * listening). */
export type Ask = (question: string) => Promise<string>

/**
 * `node:readline/promises`'s own `question()`, called repeatedly on one
 * interface, has a real race against piped/non-TTY input: readline can
 * parse several buffered lines into `line` events in one tick, and a
 * `line` that fires between two `question()` calls — while nothing is
 * listening for it — is lost, hanging the next `question()` forever.
 * Queuing every `line` event ourselves as it arrives, and having `ask`
 * just drain the queue (or wait on it), sidesteps the race for both a
 * live TTY (lines still arrive one at a time, in real time) and a piped
 * stream (all lines may already be queued by the time the first
 * question is asked).
 */
export function terminalAsk(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Ask {
  const rl = createInterface({ input, output })
  const queued: string[] = []
  const waiters: Array<(line: string) => void> = []

  rl.on('line', (line: string) => {
    const waiter = waiters.shift()
    if (waiter) waiter(line)
    else queued.push(line)
  })

  return (question: string) => {
    output.write(question)
    const queuedLine = queued.shift()
    if (queuedLine !== undefined) return Promise.resolve(queuedLine)
    return new Promise((resolve) => waiters.push(resolve))
  }
}

/**
 * M4 ticket 04: `--interactive` only renders a flat answer schema —
 * top-level object, scalar/enum properties, one prompt per property in
 * schema order (`ir/validate.ts`'s `checkFlatAnswerSchema` rejects
 * anything else at load time, so this never has to handle a shape it
 * can't render).
 */
export async function promptForAnswer(
  request: PendingRequest,
  ask: Ask,
  announce: (text: string) => void = () => {},
): Promise<Record<string, unknown>> {
  if (request.kind === 'gate') {
    announce(`\n${request.rendered}\n`)
  } else {
    announce(`\nloop "${request.stepId}" exhausted (${request.tripped}) at iteration ${request.iteration}\n`)
  }

  const schema = request.answerSchema as ObjectJsonSchema
  const required = new Set(schema.required ?? [])
  const answer: Record<string, unknown> = {}

  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    const value = await promptField(ask, name, prop, required.has(name))
    if (value !== undefined) answer[name] = value
  }

  return answer
}

async function promptField(ask: Ask, name: string, prop: JsonSchemaProp, required: boolean): Promise<unknown> {
  const label = required ? name : `${name} (optional, blank to skip)`

  for (;;) {
    const raw = (await ask(prop.enum ? `${label} [${prop.enum.join('/')}]: ` : `${label}: `)).trim()

    if (!raw) {
      if (!required) return undefined
      continue
    }
    if (prop.enum && !prop.enum.includes(raw)) continue
    if (prop.type === 'number') {
      const n = Number(raw)
      if (Number.isNaN(n)) continue
      return n
    }
    if (prop.type === 'boolean') return /^y(es)?$/i.test(raw)
    return raw
  }
}
