#!/usr/bin/env node
import { Command } from 'commander'
import { runCommand } from './commands/run.js'

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

program.parse()
