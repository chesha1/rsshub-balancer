import { DurableObject } from 'cloudflare:workers'
import { coalescerLogger, getRequestId, withRequestLogContext } from './log'
import { recordMetric } from './metrics'
import { createStateStore } from './store'
import type { ResponseSnapshot } from './types'
import { fetchFromUpstream } from './upstream'
import { fromResponse } from './utils'

type CoalescedResponse = {
  snapshot: ResponseSnapshot
  upstream?: string
}

export class RequestCoalescer extends DurableObject<CloudflareBindings> {
  // DO 级请求合并：key 为 method + requestPath，value 为正在进行的上游解析 promise。
  // 跨 isolate 的同路径同方法并发 GET/HEAD 请求在此合并，leader 完成后条目自动清除。
  private inflight = new Map<string, Promise<CoalescedResponse>>()

  async coalesce(request: Request): Promise<ResponseSnapshot> {
    const requestId = getRequestId(request)
    if (!requestId) return await this.coalesceWithContext(request)

    return await withRequestLogContext(requestId, async () =>
      this.coalesceWithContext(request),
    )
  }

  // 在已绑定 Request ID 的日志上下文里执行 DO 请求合并主流程。
  private async coalesceWithContext(
    request: Request,
  ): Promise<ResponseSnapshot> {
    const url = new URL(request.url)
    const requestPath = url.pathname + url.search
    const coalesceKey = `${request.method} ${requestPath}`
    const startedAt = Date.now()

    let promise = this.inflight.get(coalesceKey)
    let coalesceRole: 'do-leader' | 'do-follower'
    if (promise) {
      coalesceRole = 'do-follower'
      coalescerLogger.debug(
        'durable object coalescer joined an inflight request',
        {
          event: 'coalesce.join',
          coalesceRole,
        },
      )
    } else {
      coalesceRole = 'do-leader'
      coalescerLogger.debug('durable object coalescer is leading a request', {
        event: 'coalesce.join',
        coalesceRole,
      })
      promise = (async (): Promise<CoalescedResponse> => {
        try {
          const result = await fetchFromUpstream(
            request,
            createStateStore(this.env),
            (p) => this.ctx.waitUntil(p),
          )
          return {
            snapshot: await fromResponse(result.response),
            upstream: result.upstream,
          }
        } finally {
          this.inflight.delete(coalesceKey)
        }
      })()
      this.inflight.set(coalesceKey, promise)
    }

    const result = await promise
    const { snapshot } = result
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
        upstream: result.upstream,
      })
    }
    coalescerLogger.info('durable object coalescing completed', {
      event: 'coalesce.completed',
      coalesceRole,
      status: snapshot.status,
      durationMs,
    })
    return snapshot
  }
}
