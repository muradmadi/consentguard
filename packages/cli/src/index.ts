#!/usr/bin/env node
import { Command } from 'commander'

const program = new Command()

program
  .name('consentguard')
  .description('ConsentGuard CLI - Privacy proxy tools')
  .version('0.1.0')

program.command('start')
  .description('Start the ConsentGuard proxy server')
  .action(() => {
    console.log('Starting ConsentGuard proxy...')
    // Would import from @consentguard/server here eventually
  })

program.parse()
