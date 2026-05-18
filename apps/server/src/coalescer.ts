import { DurableObject } from 'cloudflare:workers'
import {
  coalescerLogger,
  getRequestId,
  getRequestLogContext,
  withRequestLogContext,
} from './log'
import { createStateStore } from './store'
import type { CoalescedRequestResult } from './types'
import { fetchFromUpstream } from './upstream'
import { fromResponse } from './utils'

export class RequestCoalescer extends DurableObject<CloudflareBindings> {
  // DO 级请求合并：key 为 method + requestPath，value 为正在进行的上游解析 promise。
  // 跨 isolate 的同路径同方法并发 GET/HEAD 请求在此合并，leader 完成后条目自动清除。
  private inflight = new Map<string, Promise<CoalescedRequestResult>>()

  async coalesce(request: Request): Promise<CoalescedRequestResult> {
    const requestId = getRequestId(request)
    const requestContext = {
      layer: 'do',
      ...getRequestLogContext(request),
      ...(requestId ? { requestId } : {}),
    }

    return await withRequestLogContext(requestContext, async () =>
      this.coalesceWithContext(request),
    )
  }

  // 在已绑定 Request ID 的日志上下文里执行 DO 请求合并主流程。
  private async coalesceWithContext(
    request: Request,
  ): Promise<CoalescedRequestResult> {
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
      promise = (async (): Promise<CoalescedRequestResult> => {
        try {
          const result = await fetchFromUpstream(
            request,
            createStateStore(this.env),
            (p) => this.ctx.waitUntil(p),
          )
          return {
            snapshot: await fromResponse(result.response),
            outcome: 'direct_upstream',
            upstream: result.upstream,
          }
        } finally {
          this.inflight.delete(coalesceKey)
        }
      })()
      this.inflight.set(coalesceKey, promise)
    }

    const sharedResult = await promise
    const result: CoalescedRequestResult =
      coalesceRole === 'do-follower'
        ? {
            snapshot: sharedResult.snapshot,
            outcome: 'do_coalesced',
          }
        : sharedResult
    const { snapshot } = result
    const durationMs = Date.now() - startedAt
    coalescerLogger.info('durable object coalescing completed', {
      event: 'coalesce.completed',
      coalesceRole,
      routeRequestOutcome: result.outcome,
      status: snapshot.status,
      durationMs,
    })
    return result
  }
}
