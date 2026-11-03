/**
 * 插件配置与路径解析。
 *
 * 默认值放在 schemastery schema 里，以便宿主渲染；profile patch 会替换整张表。
 */
import { resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { MemoryConfig } from './types.ts'

/** 作为插件 `Config` 导出的 schemastery schema。 */
export const Config: z<MemoryConfig> = z.object({  memoryDir: z.string().description('Memory root; defaults to $DSH_HOME/memory.'),
  maxCoreBytes: z.number().default(1024).description('Byte budget for the injected core layer.'),
  maxCoreItems: z.number().default(8).description('Maximum number of memories in the core layer.'),
  maxSearchResults: z.number().default(8).description('Default number of search results.'),
  maxBodyBytes: z.number().default(8192).description('Maximum memory body size in bytes.'),
  enableRecall: z.boolean().default(true).description('Inject memories relevant to the current user message.'),
  recallMaxBytes: z.number().default(1024).description('Byte budget for the per-turn recall section.'),
  recallMaxItems: z.number().default(5).description('Maximum memories in the per-turn recall section.'),
  recallIncludeCandidates: z.boolean().default(false).description('Include unverified candidates in recall.'),
  recallTimeoutMs: z.number().default(500).description('Give up recall for this step after this many milliseconds.'),
  indexBackend: z.string().default('json').description("Derived index backend: 'json' or 'sqlite' (FTS5)."),
  enableUserScope: z.boolean().default(true).description('Enable user-global memories.'),
  enableAutoCapture: z.boolean().default(false).description('Extract candidate memories when an agent is disposed.'),
  autoCaptureMaxTokens: z.number().default(2048).description('Output token cap for auto capture.'),
  autoCaptureMaxItems: z.number().default(5).description('Maximum candidates written per auto capture.'),
  trustCandidatesInCore: z.boolean().default(false).description('Allow unverified candidates into the core layer.'),
  staleAfterDays: z.number().default(180).description('Age after which an unused memory is considered stale.'),
  decayHalfLifeDays: z.number().default(180).description('Recency half-life used by ranking.'),
  projectScope: z.string().default('git').description("Project identity: 'git' or 'path'."),
  enablePanel: z.boolean().default(true).description('Register the HTTP panel API when connection is available.'),
  redactPhoneAndId: z.boolean().default(false).description('Also redact phone numbers and Chinese ID numbers.')
}) as unknown as z<MemoryConfig>

/** 把记忆根目录解析为绝对路径。 */
export function resolveMemoryDir(config: Pick<MemoryConfig, 'memoryDir'>): string {
  const configured = config.memoryDir
  if (configured !== undefined && configured.trim().length > 0) {
    return resolve(expandHomePath(configured.trim()))
  }
  return resolve(resolveDshHome(), 'memory')
}

/** 规范化部分应用的配置，并把所有默认值补齐。 */
export function normalizeConfig(config: Partial<MemoryConfig>): MemoryConfig {
  return {
    memoryDir: config.memoryDir,
    maxCoreBytes: positive(config.maxCoreBytes, 1024),
    maxCoreItems: positive(config.maxCoreItems, 8),
    maxSearchResults: positive(config.maxSearchResults, 8),
    maxBodyBytes: positive(config.maxBodyBytes, 8192),
    enableRecall: config.enableRecall ?? true,
    recallMaxBytes: positive(config.recallMaxBytes, 1024),
    recallMaxItems: positive(config.recallMaxItems, 5),
    recallIncludeCandidates: config.recallIncludeCandidates ?? false,
    recallTimeoutMs: positive(config.recallTimeoutMs, 500),
    indexBackend: config.indexBackend === 'sqlite' ? 'sqlite' : 'json',
    enableUserScope: config.enableUserScope ?? true,
    enableAutoCapture: config.enableAutoCapture ?? false,
    autoCaptureMaxTokens: positive(config.autoCaptureMaxTokens, 2048),
    autoCaptureMaxItems: positive(config.autoCaptureMaxItems, 5),
    trustCandidatesInCore: config.trustCandidatesInCore ?? false,
    staleAfterDays: nonNegative(config.staleAfterDays, 180),
    decayHalfLifeDays: positive(config.decayHalfLifeDays, 180),
    projectScope: config.projectScope === 'path' ? 'path' : 'git',
    enablePanel: config.enablePanel ?? true,
    redactPhoneAndId: config.redactPhoneAndId ?? false
  }
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function nonNegative(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}
