#!/usr/bin/env node
import { Command } from 'commander'
import type { AdapterId } from '../ir/types.js'
import { artifactsCommand } from './commands/artifacts.js'
import { resumeCommand } from './commands/resume.js'
import { runCommand } from './commands/run.js'
import { statusCommand } from './commands/status.js'

function requireAdapterId(value: string): AdapterId {
  if (value !== 'mock' && value !== 'claude-code') {
    throw new Error(`--adapter must be "mock" or "claude-code", got "${value}"`)
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
  .action(async (workflow: string, options: { adapter: string }) => {
    process.exitCode = await runCommand(workflow, requireAdapterId(options.adapter))
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
  .command('artifacts')
  .description("List a map step's per-item artifact files for a run")
  .argument('[run-id]', 'id of the run to report on (default: most recent)')
  .action(async (runId: string | undefined) => {
    process.exitCode = await artifactsCommand(runId)
  })

program.parse()
