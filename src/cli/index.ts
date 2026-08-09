#!/usr/bin/env node
import { Command } from 'commander'

const program = new Command()

program
  .name('yak')
  .description('An agentic workflow engine')
  .version('0.0.1')

program.parse()
