import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z, type ZodType } from 'zod'
import { sha256 } from '../util/hash.js'

export interface WrittenArtifact {
  name: string
  hash: string
  bytes: number
  path: string
}

function artifactPath(runDir: string, name: string): string {
  return path.join(runDir, 'artifacts', `${name}.json`)
}

export async function writeArtifact<T>(
  runDir: string,
  name: string,
  value: T,
  schema: ZodType<T>,
): Promise<WrittenArtifact> {
  const parsed = schema.parse(value)
  const json = JSON.stringify(parsed, null, 2)
  await mkdir(path.join(runDir, 'artifacts'), { recursive: true })
  const filePath = artifactPath(runDir, name)
  await writeFile(filePath, json, 'utf8')
  return { name, hash: sha256(json), bytes: Buffer.byteLength(json), path: filePath }
}

export async function readArtifact<T>(runDir: string, name: string, schema: ZodType<T>): Promise<T> {
  const json = await readFile(artifactPath(runDir, name), 'utf8')
  return schema.parse(JSON.parse(json))
}

export async function readArtifactRaw(runDir: string, name: string): Promise<unknown> {
  return readArtifact(runDir, name, z.unknown())
}

/** §3.5 schema repair loop, on final exhaustion: preserve the raw (still
 * schema-invalid) output the step actually produced, for inspection. */
export async function writeRejectedOutput(
  runDir: string,
  stepId: string,
  attempt: number,
  content: string,
): Promise<string> {
  const dir = path.join(runDir, 'artifacts', '.rejected')
  await mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${stepId}.${attempt}.txt`)
  await writeFile(filePath, content, 'utf8')
  return filePath
}
