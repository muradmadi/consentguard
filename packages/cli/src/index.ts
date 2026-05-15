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

    // Generate Production Assets
    const generateProduction = await prompts({
      type: 'confirm',
      name: 'value',
      message: 'Generate production Docker assets?',
      initial: true
    });

    if (generateProduction.value) {
      const dockerfile = `FROM node:20-slim\nWORKDIR /app\nRUN npm install -g @consentguard/cli\nEXPOSE ${response.port}\nCMD ["consentguard", "start", "--port", "${response.port}"]`;
      const dockerCompose = `services:\n  proxy:\n    build: .\n    ports:\n      - "${response.port}:${response.port}"\n    environment:\n      - REDIS_URL=redis://redis:6379\n      - PROXY_SECRET=${response.proxySecret}\n      - ADMIN_SECRET=${response.adminSecret}\n    depends_on:\n      - redis\n  redis:\n    image: redis:7-alpine\n    volumes:\n      - redis_data:/data\nvolumes:\n  redis_data:`;
      const envProd = `PORT=${response.port}\nREDIS_URL=redis://localhost:6379\nPROXY_SECRET=${response.proxySecret}\nADMIN_SECRET=${response.adminSecret}\nCG_ENABLE_CACHE=true\nCG_CACHE_TTL=60000`;

      fs.writeFileSync(path.join(process.cwd(), 'Dockerfile'), dockerfile);
      fs.writeFileSync(path.join(process.cwd(), 'docker-compose.yml'), dockerCompose);
      fs.writeFileSync(path.join(process.cwd(), '.env.production'), envProd);

      console.log(pc.green(`✅ Created ${pc.bold('Dockerfile')}`));
      console.log(pc.green(`✅ Created ${pc.bold('docker-compose.yml')}`));
      console.log(pc.green(`✅ Created ${pc.bold('.env.production')}`));
    }

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

program
  .command('dashboard')
  .description('Open the ConsentGuard Admin Dashboard')
  .action(() => {
    console.log(pc.cyan('🛡️  Launching ConsentGuard Dashboard...\n'));
    
    // For now, we'll just print the URL and instructions.
    // In a full implementation, we might start a separate process or serve it from the proxy.
    console.log(pc.white('1. Ensure the proxy is running: ') + pc.bold('consentguard start'));
    console.log(pc.white('2. Open the dashboard: ') + pc.underline(pc.blue('http://localhost:3000/dashboard')));
    console.log(pc.dim('\nTip: Use the ADMIN_SECRET from your .consentguardrc.json to log in.'));
  });

program
  .command('logs')
  .description('Stream real-time privacy enforcement logs')
  .option('-u, --url <url>', 'Proxy URL', 'http://localhost:3000')
  .option('-s, --secret <secret>', 'Admin Secret')
  .action(async (options) => {
    console.log(pc.cyan('🛡️  Streaming ConsentGuard Logs... (Ctrl+C to stop)\n'));
    
    let lastTimestamp = '';
    const secret = options.secret || process.env.ADMIN_SECRET || 'dev-admin-secret';

    const poll = async () => {
      try {
        const res = await fetch(`${options.url}/audit`, {
          headers: { 'Authorization': `Bearer ${secret}` }
        });
        
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        
        const logs: any[] = await res.json();
        const newLogs = logs.filter(l => l.timestamp > lastTimestamp).reverse();
        
        for (const log of newLogs) {
          const time = pc.dim(new Date(log.timestamp).toLocaleTimeString());
          const decision = log.decision === 'blocked' ? pc.red('BLOCKED') : 
                          log.decision === 'scrubbed' ? pc.yellow('SCRUBBED') : 
                          pc.green('FORWARDED');
          
          console.log(`${time} | ${pc.bold(log.destination.padEnd(15))} | ${decision.padEnd(20)} | ${pc.dim(log.userId)}`);
          if (log.transformationsApplied?.length > 0) {
            console.log(pc.dim(`  └─ Transformations: ${log.transformationsApplied.join(', ')}`));
          }
          lastTimestamp = log.timestamp;
        }
      } catch (e: any) {
        console.error(pc.red(`\n❌ Error polling logs: ${e.message}`));
      }
    };

    setInterval(poll, 2000);
    poll();
  });

program
  .command('status')
  .description('Check the health and status of ConsentGuard components')
  .option('-u, --url <url>', 'Proxy URL', 'http://localhost:3000')
  .option('-s, --secret <secret>', 'Admin Secret')
  .action(async (options) => {
    console.log(pc.cyan('🛡️  ConsentGuard System Status\n'));
    
    const secret = options.secret || process.env.ADMIN_SECRET || 'dev-admin-secret';

    // 1. Check Proxy Heartbeat
    try {
      const start = Date.now();
      const res = await fetch(`${options.url}/health`);
      const latency = Date.now() - start;
      
      if (res.ok) {
        const data: any = await res.json();
        console.log(`${pc.green('●')} Proxy:     ${pc.bold('Online')} ${pc.dim(`(${latency}ms)`)}`);
        console.log(`  └─ Runtime: ${pc.dim(data.storage === 'RedisStorageProvider' ? 'Node.js + Redis' : 'In-Memory / Edge')}`);
      } else {
        console.log(`${pc.red('○')} Proxy:     ${pc.bold('Error')} ${pc.dim(`(HTTP ${res.status})`)}`);
      }
    } catch (e) {
      console.log(`${pc.red('○')} Proxy:     ${pc.bold('Offline')} ${pc.dim('(Connection Refused)')}`);
    }

    // 2. Check Stats & Registry
    try {
      const res = await fetch(`${options.url}/api/stats`, {
        headers: { 'Authorization': `Bearer ${secret}` }
      });
      
      if (res.ok) {
        const stats: any = await res.json();
        console.log(`${pc.green('●')} Stats:     ${pc.bold('Accessible')}`);
        console.log(`  ├─ Requests:  ${pc.cyan(stats.totalRequests || 0)}`);
        console.log(`  ├─ Blocked:   ${pc.red(stats.blockedRequests || 0)}`);
        console.log(`  └─ Errors:    ${pc.red(stats.errors || 0)}`);
      } else {
        console.log(`${pc.yellow('○')} Stats:     ${pc.bold('Unauthorized')} ${pc.dim('(Check ADMIN_SECRET)')}`);
      }
    } catch (e) {}

    // 3. Check Rules
    try {
      const res = await fetch(`${options.url}/api/rules`, {
        headers: { 'Authorization': `Bearer ${secret}` }
      });
      
      if (res.ok) {
        const rules: any[] = await res.json();
        console.log(`${pc.green('●')} Registry:  ${pc.bold(rules.length + ' Rules Loaded')}`);
        const overrides = rules.filter(r => r._isOverride).length;
        if (overrides > 0) {
          console.log(`  └─ Overrides: ${pc.yellow(overrides + ' active')}`);
        }
      }
    } catch (e) {}

    console.log(pc.dim('\nUse "consentguard logs" to see real-time traffic.'));
  });

program.parse();
