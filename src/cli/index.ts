#!/usr/bin/env node
import { Command } from 'commander'
import type { AdapterId, RunIsolation } from '../ir/types.js'
import { artifactsCommand } from './commands/artifacts.js'
import { graphCommand } from './commands/graph.js'
import { pendingCommand } from './commands/pending.js'
import { resumeCommand } from './commands/resume.js'
import { runCommand } from './commands/run.js'
import { statusCommand } from './commands/status.js'
import { watchCommand } from './commands/watch.js'

function requireAdapterId(value: string): AdapterId {
  if (value !== 'mock' && value !== 'claude-code') {
    throw new Error(`--adapter must be "mock" or "claude-code", got "${value}"`)
  }
  return value
}

function requireIsolation(value: string): RunIsolation {
  if (value !== 'worktree' && value !== 'none') {
    throw new Error(`--isolation must be "worktree" or "none", got "${value}"`)
  }
  return value
}

const program = new Command()

program
  .name('yak')
  .description('An agentic workflow engine')
  .version('0.0.1')

program
  .command('run')
  .description('Run a workflow YAML file')
  .argument('<workflow>', 'path to the workflow YAML file')
  .option('--adapter <adapter>', 'agent adapter to use', 'claude-code')
  .option('--interactive', 'prompt inline for gate answers instead of exiting to resume later', false)
  .option('--isolation <mode>', 'run inside a fresh git worktree ("worktree") or the plain cwd ("none")', 'none')
  .action(async (workflow: string, options: { adapter: string; interactive: boolean; isolation: string }) => {
    process.exitCode = await runCommand(workflow, {
      adapter: requireAdapterId(options.adapter),
      interactive: options.interactive,
      isolation: requireIsolation(options.isolation),
    })
  })

program
  .command('resume')
  .description('Resume an interrupted run')
  .argument('<run-id>', 'id of the run to resume')
  .option('--adapter <adapter>', 'must match the adapter the run started with, if given')
  .action(async (runId: string, options: { adapter?: string }) => {
    process.exitCode = await resumeCommand(runId, options.adapter ? requireAdapterId(options.adapter) : undefined)
  })

program
  .command('status')
  .description("Report a run's per-step status")
  .argument('[run-id]', 'id of the run to report on (default: most recent)')
  .action(async (runId: string | undefined) => {
    process.exitCode = await statusCommand(runId)
  })

program
  .command('pending')
  .description('List every run across the repo awaiting a human answer')
  .action(async () => {
    process.exitCode = await pendingCommand()
  })

program
  .command('graph')
  .description("Emit a workflow's DAG as Mermaid to stdout")
  .argument('<workflow>', 'path to the workflow YAML file')
  .action(async (workflow: string) => {
    process.exitCode = await graphCommand(workflow)
  })

program
  .command('watch')
  .description("Live-tail a run's step statuses in a terminal UI")
  .argument('[run-id]', 'id of the run to watch (default: most recent)')
  .action(async (runId: string | undefined) => {
    process.exitCode = await watchCommand(runId)
  })

program
  .command('artifacts')
  .description("List a map step's per-item artifact files for a run")
  .argument('[run-id]', 'id of the run to report on (default: most recent)')
  .action(async (runId: string | undefined) => {
    process.exitCode = await artifactsCommand(runId)
  })

try {
  await program.parseAsync()
} catch (err) {
  console.error((err as Error).message)
  process.exitCode = 1
}
