import { z } from 'zod'

export const upstreamsResponseSchema = z.object({
  upstreams: z.array(z.string()),
})

const trafficSankeyOutcomeSchema = z.enum([
  'direct_upstream',
  'isolate_coalesced',
  'do_coalesced',
])

export const trafficSankeyRowSchema = z.object({
  country: z.string(),
  edgeColo: z.string(),
  outcome: trafficSankeyOutcomeSchema,
  upstream: z.string(),
  value: z.number(),
})

export const trafficSankeyResponseSchema = z.object({
  rows: z.array(trafficSankeyRowSchema),
})

export type TrafficSankeyRow = z.infer<typeof trafficSankeyRowSchema>
