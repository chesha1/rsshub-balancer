import { DurableObject } from 'cloudflare:workers'
import { bindRequestLogger, coalescerLogger } from './log'
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

    let promise = this.inflight.get(requestPath)
    if (promise) {
      logger.debug('durable object coalescer joined an inflight request', {
        event: 'coalesce.join',
        coalesceRole: 'do-follower',
      })
    } else {
      logger.debug('durable object coalescer is leading a request', {
        event: 'coalesce.join',
        coalesceRole: 'do-leader',
      })
      promise = fetchFromUpstream(
        request,
        this.env.KV,
        (p) => this.ctx.waitUntil(p),
        requestId,
      )
        .then((res) => fromResponse(res))
        .finally(() => this.inflight.delete(requestPath))
      this.inflight.set(requestPath, promise)
    }

    return await promise
  }
}
