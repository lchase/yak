#!/usr/bin/env node
import { Command } from 'commander'
import { resumeCommand } from './commands/resume.js'
import { runCommand } from './commands/run.js'
import { statusCommand } from './commands/status.js'

const program = new Command()

program
  .name('yak')
  .description('An agentic workflow engine')
  .version('0.0.1')

program
  .command('run')
  .description('Run a workflow YAML file')
  .argument('<workflow>', 'path to the workflow YAML file')
  .action(async (workflow: string) => {
    process.exitCode = await runCommand(workflow)
  })

program
  .command('resume')
  .description('Resume an interrupted run')
  .argument('<run-id>', 'id of the run to resume')
  .action(async (runId: string) => {
    process.exitCode = await resumeCommand(runId)
  })

program
  .command('status')
  .description("Report a run's per-step status")
  .argument('[run-id]', 'id of the run to report on (default: most recent)')
  .action(async (runId: string | undefined) => {
    process.exitCode = await statusCommand(runId)
  })

program.parse()
