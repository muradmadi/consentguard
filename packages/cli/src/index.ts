#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import prompts from 'prompts';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

const program = new Command();

program
  .name('consentguard')
  .description('ConsentGuard CLI - Manage your privacy proxy')
  .version('0.1.0');

program
  .command('init')
  .description('Initialize a new ConsentGuard configuration')
  .action(async () => {
    console.log(pc.cyan('🛡️  ConsentGuard Initialization\n'));

    const response = await prompts([
      {
        type: 'number',
        name: 'port',
        message: 'Which port should the proxy run on?',
        initial: 3000
      },
      {
        type: 'text',
        name: 'redisUrl',
        message: 'Redis Connection URL',
        initial: 'redis://localhost:6379'
      },
      {
        type: 'password',
        name: 'proxySecret',
        message: 'Proxy Secret (used for client authentication)',
        initial: 'change-me-proxy'
      },
      {
        type: 'password',
        name: 'adminSecret',
        message: 'Admin Secret (used for dashboard/API)',
        initial: 'change-me-admin'
      }
    ]);

    const configPath = path.join(process.cwd(), '.consentguardrc.json');
    fs.writeFileSync(configPath, JSON.stringify(response, null, 2));

    console.log(pc.green(`\n✅ Created ${pc.bold('.consentguardrc.json')}`));
    console.log(pc.dim('\nYou can now run: ') + pc.bold('consentguard start'));
  });

program
  .command('start')
  .description('Start the ConsentGuard proxy server')
  .option('-p, --port <number>', 'Port to run on')
  .action((options) => {
    console.log(pc.cyan('🛡️  Starting ConsentGuard Proxy...\n'));

    // In a real CLI, we would import the server and run it.
    // For now, we'll spawn the node process pointing to the server's index.
    // We assume the server package is built and available.
    
    const serverPath = path.join(__dirname, '../../server/dist/index.js');
    
    if (!fs.existsSync(serverPath)) {
      console.error(pc.red('❌ Error: Server not found. Please run "npm run build" first.'));
      process.exit(1);
    }

    const env = { ...process.env };
    if (options.port) env.PORT = options.port;

    const child = spawn('node', [serverPath], {
      env,
      stdio: 'inherit'
    });

    child.on('exit', (code) => {
      console.log(pc.dim(`Proxy exited with code ${code}`));
    });
  });

program.parse();
