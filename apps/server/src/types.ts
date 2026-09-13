import type { Context } from 'hono'
import type { MetricsBinding } from './metrics-schema'

export type AppEnv = {
  Bindings: {
    METRICS?: MetricsBinding
  }
}

export type AppContext = Context<AppEnv>

export type RouteRequestOutcome = 'direct_upstream'
