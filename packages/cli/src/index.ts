#!/usr/bin/env node
import { Command } from 'commander'
import pc from 'picocolors'
import prompts from 'prompts'
import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import type { AuditPage, ChainStatus } from '@sluice/shared'
import { buildConfig, renderCompose } from './config'

declare const __CLI_VERSION__: string

const program = new Command()

/**
 * The admin bearer for a CLI call. There is no default: a fallback that every
 * install shares is a published credential, and guessing wrong here silently
 * reports "Unauthorized" instead of saying what is missing.
 */
function requireSecret(fromFlag?: string): string {
  const secret = fromFlag || process.env.ADMIN_SECRET
  if (!secret) {
    console.error(
      pc.red('❌ No admin secret. Pass --secret, or set ADMIN_SECRET in the environment.'),
    )
    process.exit(1)
  }
  return secret
}

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
        message: 'Admin secret (bearer token for /audit, /api/rules — blank to generate one)',
      },
      {
        type: 'text',
        name: 'allowedOrigins',
        message: 'Comma-separated allowed origins (empty = allow all, dev only)',
        initial: 'http://localhost:3000',
      },
    ])

    const config = buildConfig(response)

    const configPath = path.join(process.cwd(), '.sluicerc.json')
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
    console.log(pc.green(`\nCreated ${pc.bold('.sluicerc.json')}`))
    if (!response.adminSecret) {
      console.log(pc.dim('Generated admin secret: ') + pc.bold(config.adminSecret))
    }

    const generateProduction = await prompts({
      type: 'confirm',
      name: 'value',
      message: 'Generate a docker-compose.yml with Redis?',
      initial: true,
    })

    if (generateProduction.value) {
      fs.writeFileSync(path.join(process.cwd(), 'docker-compose.yml'), renderCompose(config))
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
      console.error(pc.red('❌ Error: Server not found. Please run "just build" first.'))
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

    // ISO 8601 timestamps sort lexicographically, so a string cursor works.
    let lastTimestamp = ''
    const secret = requireSecret(options.secret)

    const poll = async () => {
      try {
        const res = await fetch(`${options.url}/audit`, {
          headers: { Authorization: `Bearer ${secret}` },
        })

        if (!res.ok) throw new Error(`HTTP ${res.status}`)

        const page = (await res.json()) as AuditPage
        const newLogs = page.records.filter((l) => l.timestamp > lastTimestamp).reverse()

        for (const log of newLogs) {
          const time = pc.dim(new Date(log.timestamp).toLocaleTimeString())
          const decision =
            log.decision === 'blocked'
              ? pc.red('BLOCKED')
              : log.decision === 'failed'
                ? pc.red('FAILED')
                : pc.green('FORWARDED')

          console.log(
            `${time} | ${pc.bold(log.destination.padEnd(15))} | ${decision.padEnd(20)} | ${pc.dim(log.userId)}`,
          )
          for (const t of log.transformations) {
            // An entry with a detector was found by the value scan; without one
            // it came from a path the destination's rule declared.
            const origin = t.detector ? pc.yellow(`detected ${t.detector}`) : 'declared'
            // A match key is a digest the vendor can join back to a person and a
            // pseudonym is not, so the line says which one was applied.
            const action = t.mode ? `${t.action}:${t.mode}` : t.action
            console.log(pc.dim(`  └─ ${action} ${t.path} ×${t.matched} `) + pc.dim(`(${origin})`))
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

/**
 * Colour carries the meaning here: a destination the proxy refuses should not
 * read the same as one it serves. Never derived locally — the level comes from
 * the proxy, which is the only thing that knows which adapters this build has.
 */
function supportLabel(support: string): string {
  switch (support) {
    case 'adapter':
      return pc.green('adapter    ')
    case 'passthrough':
      return pc.cyan('passthrough')
    case 'unsupported':
      return pc.red('unsupported')
    default:
      return pc.dim((support || 'unknown').padEnd(11))
  }
}

program
  .command('status')
  .description('Check the health and status of Sluice components')
  .option('-u, --url <url>', 'Proxy URL', 'http://localhost:3000')
  .option('-s, --secret <secret>', 'Admin Secret')
  .action(async (options) => {
    console.log(pc.cyan('🛡️  Sluice System Status\n'))

    const secret = requireSecret(options.secret)

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
        // `totalRequests` and `blockedRequests` were never fields /api/stats
        // returns, so both printed 0 whatever the proxy had counted — an
        // operator surface stating a number it had not obtained.
        const decisions = stats.decisions || { forwarded: 0, blocked: 0 }
        console.log(`${pc.green('●')} Stats:     ${pc.bold('Accessible')}`)
        console.log(`  ├─ Requests:  ${pc.cyan(decisions.forwarded + decisions.blocked)}`)
        console.log(`  ├─ Blocked:   ${pc.red(decisions.blocked)}`)
        console.log(`  └─ Errors:    ${pc.red(stats.errors || 0)}`)
      } else {
        console.log(
          `${pc.yellow('○')} Stats:     ${pc.bold('Unauthorized')} ${pc.dim('(Check ADMIN_SECRET)')}`,
        )
      }
    } catch {
      /* best-effort probe; the offline case is already reported above */
    }

    // 3. Check the durable record — the claim is "and here is the proof", so
    //    how much proof there is, and whether it still verifies, is status.
    try {
      const res = await fetch(`${options.url}/api/health`, {
        headers: { Authorization: `Bearer ${secret}` },
      })

      if (res.ok) {
        const health = (await res.json()) as any
        const audit = health.audit
        if (!audit.configured) {
          console.log(`${pc.yellow('○')} Audit:     ${pc.bold('No durable record')}`)
          console.log(
            pc.dim(
              `  └─ A ${audit.cacheEntries}-entry cache that rolls over. Set SLUICE_AUDIT_DIR.`,
            ),
          )
        } else {
          const marker = audit.evidenceAvailable ? pc.green('●') : pc.red('○')
          console.log(
            `${marker} Audit:     ${pc.bold(`${audit.entries} records`)}${
              audit.retentionDays ? pc.dim(` (${audit.retentionDays}-day retention)`) : ''
            }`,
          )
          if (audit.oldest) {
            console.log(`  ├─ Oldest:    ${pc.dim(new Date(audit.oldest).toISOString())}`)
          }
          if (audit.head) {
            console.log(
              `  ├─ Head:      ${pc.dim(`#${audit.head.seq} ${audit.head.hash.slice(0, 12)}`)}`,
            )
          }
          console.log(`  └─ Location:  ${pc.dim(audit.location)}`)
          if (!audit.evidenceAvailable) {
            console.log(
              pc.red(`     Not recording — forwarding is stopped. ${audit.lastError ?? ''}`),
            )
          }
        }
      }
    } catch {
      /* best-effort probe; the offline case is already reported above */
    }

    // 4. Check Rules
    try {
      const res = await fetch(`${options.url}/api/rules`, {
        headers: { Authorization: `Bearer ${secret}` },
      })

      if (res.ok) {
        const rules: any[] = await res.json()
        console.log(`${pc.green('●')} Registry:  ${pc.bold(rules.length + ' destinations')}`)

        // What the proxy can actually do with each one, as the proxy derives
        // it. The registry used to list six destinations and serve one, and
        // there was no surface that would have told anyone.
        rules.forEach((rule, i) => {
          const last = i === rules.length - 1
          console.log(
            `  ${last ? '└─' : '├─'} ${rule.id.padEnd(15)} ${supportLabel(rule.support)}` +
              pc.dim(` ${rule.transport}`),
          )
        })

        const unsupported = rules.filter((r) => r.support === 'unsupported')
        if (unsupported.length > 0) {
          const subject = unsupported.length === 1 ? 'Its payload' : 'Their payloads'
          console.log(
            pc.yellow(
              `     ${unsupported.length} refused at /ingest: ${unsupported
                .map((r) => r.id)
                .join(', ')}. ${subject} cannot be scrubbed, so nothing is forwarded.`,
            ),
          )
        }

        const overrides = rules.filter((r) => r._isOverride).length
        if (overrides > 0) {
          console.log(`     Overrides: ${pc.yellow(overrides + ' active')}`)
        }
      }
    } catch {
      /* best-effort probe; the offline case is already reported above */
    }

    console.log(
      pc.dim('\nUse "sluice logs" to see real-time traffic, "sluice verify" to check the chain.'),
    )
  })

/**
 * Check that the record still holds together.
 *
 * Every audit entry carries the digest of the one before it, so an edit or a
 * deletion breaks the chain. Exits non-zero on a break so this can run from
 * cron and be noticed.
 */
program
  .command('verify')
  .description('Verify the audit chain has not been edited or truncated')
  .option('-u, --url <url>', 'Proxy URL', 'http://localhost:3000')
  .option('-s, --secret <secret>', 'Admin Secret')
  .action(async (options) => {
    const secret = requireSecret(options.secret)

    let result: ChainStatus
    try {
      const res = await fetch(`${options.url}/audit/verify`, {
        headers: { Authorization: `Bearer ${secret}` },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      result = (await res.json()) as ChainStatus
    } catch (e: any) {
      console.error(pc.red(`❌ Could not reach the proxy: ${e.message}`))
      process.exit(1)
    }

    const head = result.head ? `#${result.head.seq} ${result.head.hash.slice(0, 12)}` : 'none'

    switch (result.status) {
      case 'intact':
        console.log(pc.green(`✓ Chain intact — ${result.checked} records verified, head ${head}`))
        break
      case 'truncated':
        // Retention deleting old segments is not tampering; say so plainly.
        console.log(
          pc.green(
            `✓ Chain intact for the retained window — ${result.checked} records, head ${head}`,
          ),
        )
        console.log(pc.dim(`  ${result.reason ?? ''}`))
        break
      case 'unavailable':
        console.log(
          pc.yellow(`○ Nothing to verify — ${result.reason ?? 'no durable audit record'}`),
        )
        break
      default:
        console.error(pc.red(`✗ Chain ${result.status} at seq ${result.brokenAt}`))
        console.error(pc.red(`  ${result.reason ?? ''}`))
        process.exit(1)
    }
  })

/**
 * Produce the record for someone who asked for it.
 *
 * Writes to a file or to stdout, so it can be piped or attached as-is. NDJSON
 * carries the hashes, which is what makes an export re-verifiable rather than
 * something the recipient has to take on trust.
 */
program
  .command('export')
  .description('Export audit records as NDJSON or CSV')
  .option('-u, --url <url>', 'Proxy URL', 'http://localhost:3000')
  .option('-s, --secret <secret>', 'Admin Secret')
  .option('-f, --format <format>', 'ndjson or csv', 'ndjson')
  .option('--from <iso>', 'Only records at or after this time')
  .option('--to <iso>', 'Only records at or before this time')
  .option('-d, --destination <id>', 'Only this destination')
  .option('--decision <decision>', 'forwarded, blocked or failed')
  .option('--detector <detector>', 'Only records where this detector fired')
  .option('-l, --limit <n>', 'Maximum records', '10000')
  .option('-o, --out <file>', 'Write to a file instead of stdout')
  .action(async (options) => {
    const secret = requireSecret(options.secret)

    if (options.format !== 'ndjson' && options.format !== 'csv') {
      console.error(pc.red('❌ --format must be ndjson or csv'))
      process.exit(1)
    }

    const params = new URLSearchParams({ format: options.format, limit: options.limit })
    for (const key of ['from', 'to', 'destination', 'decision', 'detector'] as const) {
      if (options[key]) params.set(key, options[key])
    }

    try {
      const res = await fetch(`${options.url}/audit?${params.toString()}`, {
        headers: { Authorization: `Bearer ${secret}` },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.text()

      if (options.out) {
        fs.writeFileSync(options.out, body)
        const lines = body.trim() ? body.trim().split('\n').length : 0
        console.log(pc.green(`Wrote ${lines} line(s) to ${pc.bold(options.out)}`))
      } else {
        process.stdout.write(body)
      }
    } catch (e: any) {
      console.error(pc.red(`❌ Export failed: ${e.message}`))
      process.exit(1)
    }
  })

program.parse()
