import { DurableObject } from 'cloudflare:workers'
import { bindRequestLogger, coalescerLogger } from './log'
import { recordMetric } from './metrics'
import { createStateStore } from './store'
import type { ResponseSnapshot } from './types'
import { fetchFromUpstream } from './upstream'
import { fromResponse } from './utils'

export class RequestCoalescer extends DurableObject<CloudflareBindings> {
  // DO 级请求合并：key 为 requestPath（pathname + search），value 为正在进行的上游解析 promise。
  // 跨 isolate 的同路径并发 GET 请求在此合并，leader 完成后条目自动清除。
  private inflight = new Map<string, Promise<ResponseSnapshot>>()

  async coalesce(
    request: Request,
    requestId: string,
  ): Promise<ResponseSnapshot> {
    const logger = bindRequestLogger(coalescerLogger, requestId, request)
    const url = new URL(request.url)
    const requestPath = url.pathname + url.search
    const startedAt = Date.now()

    let promise = this.inflight.get(requestPath)
    let coalesceRole: 'do-leader' | 'do-follower'
    if (promise) {
      coalesceRole = 'do-follower'
      logger.debug('durable object coalescer joined an inflight request', {
        event: 'coalesce.join',
        coalesceRole,
      })
    } else {
      coalesceRole = 'do-leader'
      logger.debug('durable object coalescer is leading a request', {
        event: 'coalesce.join',
        coalesceRole,
      })
      promise = (async (): Promise<ResponseSnapshot> => {
        try {
          const res = await fetchFromUpstream(
            request,
            createStateStore(this.env),
            (p) => this.ctx.waitUntil(p),
            requestId,
          )
          return await fromResponse(res)
        } finally {
          this.inflight.delete(requestPath)
        }
      })()
      this.inflight.set(requestPath, promise)
    }

    const snapshot = await promise
    const durationMs = Date.now() - startedAt
    recordMetric(this.env.METRICS, {
      metric: 'coalesce_role',
      layer: 'do',
      role: coalesceRole === 'do-leader' ? 'leader' : 'follower',
      method: request.method,
      reason: coalesceRole === 'do-follower' ? 'do_follower' : 'none',
      status: snapshot.status,
      durationMs,
    })
    if (coalesceRole === 'do-follower') {
      recordMetric(this.env.METRICS, {
        metric: 'benefited',
        layer: 'do',
        role: 'follower',
        method: request.method,
        reason: 'do_follower',
        status: snapshot.status,
        durationMs,
      })
    } else {
      recordMetric(this.env.METRICS, {
        metric: 'direct_upstream',
        layer: 'do',
        role: 'leader',
        method: request.method,
        reason: 'do_leader',
        status: snapshot.status,
        durationMs,
      })
    }
    logger.info('durable object coalescing completed', {
      event: 'coalesce.completed',
      coalesceRole,
      status: snapshot.status,
      durationMs,
    })
    return snapshot
  }
}
