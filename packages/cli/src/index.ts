#!/usr/bin/env node
import { Command } from 'commander'
import pc from 'picocolors'
import prompts from 'prompts'
import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'

declare const __CLI_VERSION__: string

const program = new Command()

program
  .name('sluice')
  .description('Sluice CLI - Manage your privacy proxy')
  .version(__CLI_VERSION__)

program
  .command('init')
  .description('Initialize a new Sluice configuration')
  .action(async () => {
    console.log(pc.cyan('🛡️  Sluice Initialization\n'))

    const response = await prompts([
      {
        type: 'number',
        name: 'port',
        message: 'Which port should the proxy run on?',
        initial: 3000,
      },
      {
        type: 'text',
        name: 'redisUrl',
        message: 'Redis connection URL (leave default to use in-memory)',
        initial: 'redis://localhost:6379',
      },
      {
        type: 'password',
        name: 'adminSecret',
        message: 'Admin secret (bearer token for /audit, /api/rules, etc.)',
        initial: 'dev-admin-secret',
      },
      {
        type: 'text',
        name: 'allowedOrigins',
        message: 'Comma-separated allowed origins (empty = allow all, dev only)',
        initial: 'http://localhost:3000',
      },
    ])

    const config = {
      port: response.port,
      redisUrl: response.redisUrl,
      adminSecret: response.adminSecret,
      allowedOrigins: (response.allowedOrigins || '')
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean),
    }

    const configPath = path.join(process.cwd(), '.sluicerc.json')
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
    console.log(pc.green(`\nCreated ${pc.bold('.sluicerc.json')}`))

    const generateProduction = await prompts({
      type: 'confirm',
      name: 'value',
      message: 'Generate a docker-compose.yml with Redis?',
      initial: true,
    })

    if (generateProduction.value) {
      const originsEnv = config.allowedOrigins.join(',')
      const compose = [
        'services:',
        '  proxy:',
        '    build: .',
        `    ports:`,
        `      - "${config.port}:${config.port}"`,
        '    environment:',
        `      - PORT=${config.port}`,
        '      - REDIS_URL=redis://redis:6379',
        `      - ADMIN_SECRET=${config.adminSecret}`,
        `      - SLUICE_ALLOWED_ORIGINS=${originsEnv}`,
        '      - SLUICE_ENABLE_CACHE=true',
        '      - GA4_MEASUREMENT_ID=',
        '      - GA4_API_SECRET=',
        '    depends_on:',
        '      - redis',
        '  redis:',
        '    image: redis:7-alpine',
        '    volumes:',
        '      - redis_data:/data',
        'volumes:',
        '  redis_data:',
        '',
      ].join('\n')
      fs.writeFileSync(path.join(process.cwd(), 'docker-compose.yml'), compose)
      console.log(pc.green(`Created ${pc.bold('docker-compose.yml')}`))
    }

    console.log(pc.dim('\nYou can now run: ') + pc.bold('sluice start'))
  })

program
  .command('start')
  .description('Start the Sluice proxy server')
  .option('-p, --port <number>', 'Port to run on')
  .action((options) => {
    console.log(pc.cyan('🛡️  Starting Sluice Proxy...\n'))

    // In a real CLI, we would import the server and run it.
    // For now, we'll spawn the node process pointing to the server's index.
    // We assume the server package is built and available.

    const serverPath = path.join(__dirname, '../../server/dist/index.js')

    if (!fs.existsSync(serverPath)) {
      console.error(pc.red('❌ Error: Server not found. Please run "npm run build" first.'))
      process.exit(1)
    }

    const env = { ...process.env }
    if (options.port) env.PORT = options.port

    const child = spawn('node', [serverPath], {
      env,
      stdio: 'inherit',
    })

    child.on('exit', (code) => {
      console.log(pc.dim(`Proxy exited with code ${code}`))
    })
  })

program
  .command('dashboard')
  .description('Open the Sluice Admin Dashboard')
  .action(() => {
    console.log(pc.cyan('🛡️  Launching Sluice Dashboard...\n'))

    // For now, we'll just print the URL and instructions.
    // In a full implementation, we might start a separate process or serve it from the proxy.
    console.log(pc.white('1. Ensure the proxy is running: ') + pc.bold('sluice start'))
    console.log(
      pc.white('2. Open the dashboard: ') +
        pc.underline(pc.blue('http://localhost:3000/dashboard')),
    )
    console.log(pc.dim('\nTip: Use the ADMIN_SECRET from your .sluicerc.json to log in.'))
  })

program
  .command('logs')
  .description('Stream real-time privacy enforcement logs')
  .option('-u, --url <url>', 'Proxy URL', 'http://localhost:3000')
  .option('-s, --secret <secret>', 'Admin Secret')
  .action(async (options) => {
    console.log(pc.cyan('🛡️  Streaming Sluice Logs... (Ctrl+C to stop)\n'))

    let lastTimestamp = ''
    const secret = options.secret || process.env.ADMIN_SECRET || 'dev-admin-secret'

    const poll = async () => {
      try {
        const res = await fetch(`${options.url}/audit`, {
          headers: { Authorization: `Bearer ${secret}` },
        })

        if (!res.ok) throw new Error(`HTTP ${res.status}`)

        const logs: any[] = await res.json()
        const newLogs = logs.filter((l) => l.timestamp > lastTimestamp).reverse()

        for (const log of newLogs) {
          const time = pc.dim(new Date(log.timestamp).toLocaleTimeString())
          const decision =
            log.decision === 'blocked'
              ? pc.red('BLOCKED')
              : log.decision === 'scrubbed'
                ? pc.yellow('SCRUBBED')
                : pc.green('FORWARDED')

          console.log(
            `${time} | ${pc.bold(log.destination.padEnd(15))} | ${decision.padEnd(20)} | ${pc.dim(log.userId)}`,
          )
          if (log.transformationsApplied?.length > 0) {
            console.log(pc.dim(`  └─ Transformations: ${log.transformationsApplied.join(', ')}`))
          }
          lastTimestamp = log.timestamp
        }
      } catch (e: any) {
        console.error(pc.red(`\n❌ Error polling logs: ${e.message}`))
      }
    }

    setInterval(poll, 2000)
    poll()
  })

program
  .command('status')
  .description('Check the health and status of Sluice components')
  .option('-u, --url <url>', 'Proxy URL', 'http://localhost:3000')
  .option('-s, --secret <secret>', 'Admin Secret')
  .action(async (options) => {
    console.log(pc.cyan('🛡️  Sluice System Status\n'))

    const secret = options.secret || process.env.ADMIN_SECRET || 'dev-admin-secret'

    // 1. Check Proxy Heartbeat
    try {
      const start = Date.now()
      const res = await fetch(`${options.url}/health`)
      const latency = Date.now() - start

      if (res.ok) {
        const data: any = await res.json()
        console.log(`${pc.green('●')} Proxy:     ${pc.bold('Online')} ${pc.dim(`(${latency}ms)`)}`)
        console.log(
          `  └─ Runtime: ${pc.dim(data.storage === 'RedisStorageProvider' ? 'Node.js + Redis' : 'In-Memory / Edge')}`,
        )
      } else {
        console.log(
          `${pc.red('○')} Proxy:     ${pc.bold('Error')} ${pc.dim(`(HTTP ${res.status})`)}`,
        )
      }
    } catch {
      console.log(
        `${pc.red('○')} Proxy:     ${pc.bold('Offline')} ${pc.dim('(Connection Refused)')}`,
      )
    }

    // 2. Check Stats & Registry
    try {
      const res = await fetch(`${options.url}/api/stats`, {
        headers: { Authorization: `Bearer ${secret}` },
      })

      if (res.ok) {
        const stats: any = await res.json()
        console.log(`${pc.green('●')} Stats:     ${pc.bold('Accessible')}`)
        console.log(`  ├─ Requests:  ${pc.cyan(stats.totalRequests || 0)}`)
        console.log(`  ├─ Blocked:   ${pc.red(stats.blockedRequests || 0)}`)
        console.log(`  └─ Errors:    ${pc.red(stats.errors || 0)}`)
      } else {
        console.log(
          `${pc.yellow('○')} Stats:     ${pc.bold('Unauthorized')} ${pc.dim('(Check ADMIN_SECRET)')}`,
        )
      }
    } catch {
      /* best-effort probe; the offline case is already reported above */
    }

    // 3. Check Rules
    try {
      const res = await fetch(`${options.url}/api/rules`, {
        headers: { Authorization: `Bearer ${secret}` },
      })

      if (res.ok) {
        const rules: any[] = await res.json()
        console.log(`${pc.green('●')} Registry:  ${pc.bold(rules.length + ' Rules Loaded')}`)
        const overrides = rules.filter((r) => r._isOverride).length
        if (overrides > 0) {
          console.log(`  └─ Overrides: ${pc.yellow(overrides + ' active')}`)
        }
      }
    } catch {
      /* best-effort probe; the offline case is already reported above */
    }

    console.log(pc.dim('\nUse "sluice logs" to see real-time traffic.'))
  })

program.parse()
