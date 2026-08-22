/**
 * Lightweight Metrics Collector
 * Tracks blocks, forwards, and errors for the proxy.
 */
export class MetricsCollector {
  private static instance: MetricsCollector

  private metrics = {
    requestsTotal: {} as Record<string, number>,
    decisions: {
      blocked: 0,
      forwarded: 0,
    },
    errors: 0,
    startTime: Date.now(),
  }

  private constructor() {}

  public static getInstance(): MetricsCollector {
    if (!MetricsCollector.instance) {
      MetricsCollector.instance = new MetricsCollector()
    }
    return MetricsCollector.instance
  }

  public recordRequest(destination: string, decision: 'blocked' | 'forwarded') {
    const key = `${destination}:${decision}`
    this.metrics.requestsTotal[key] = (this.metrics.requestsTotal[key] || 0) + 1

    if (decision === 'blocked') {
      this.metrics.decisions.blocked++
    } else {
      this.metrics.decisions.forwarded++
    }
  }

  public recordError() {
    this.metrics.errors++
  }

  public reset() {
    this.metrics = {
      requestsTotal: {},
      decisions: {
        blocked: 0,
        forwarded: 0,
      },
      errors: 0,
      startTime: Date.now(),
    }
  }

  public getMetrics() {
    return {
      ...this.metrics,
      uptimeSeconds: Math.floor((Date.now() - this.metrics.startTime) / 1000),
      timestamp: new Date().toISOString(),
    }
  }

  /**
   * Returns metrics in a pseudo-Prometheus format
   */
  public toPrometheus() {
    let output = '# HELP sluice_requests_total Total requests processed by Sluice\n'
    output += '# TYPE sluice_requests_total counter\n'

    for (const [key, value] of Object.entries(this.metrics.requestsTotal)) {
      const [dest, decision] = key.split(':')
      output += `sluice_requests_total{destination="${dest}", decision="${decision}"} ${value}\n`
    }

    output += `\n# HELP sluice_errors_total Total upstream errors\n`
    output += `sluice_errors_total ${this.metrics.errors}\n`

    output += `\n# HELP sluice_uptime_seconds Uptime in seconds\n`
    output += `sluice_uptime_seconds ${Math.floor((Date.now() - this.metrics.startTime) / 1000)}\n`

    return output
  }
}

export const metrics = MetricsCollector.getInstance()
