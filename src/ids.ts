/**
 * 稳定的标识符与链接语法。
 *
 * 记录使用 ULID，这样即使 slug 或措辞发生变化，记忆仍能保持同一身份。链接可以是
 * ULID（带或不带 `mem_` 显示前缀），也可以是在同一作用域内解析的 slug。
 */
import { randomBytes } from 'node:crypto'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 生成一个单调性足够好的 ULID（26 个字符，Crockford base32）。 */
export function generateUlid(now: number = Date.now()): string {
  let time = Math.floor(now)
  let out = ''
  for (let i = 0; i < 10; i += 1) {
    out = CROCKFORD[time % 32]! + out
    time = Math.floor(time / 32)
  }
  const random = randomBytes(16)
  for (let i = 0; i < 16; i += 1) {
    out += CROCKFORD[random[i]! % 32]!
  }
  return out
}

/** 判断字符串是否为规范形式的 ULID id。 */
export function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value)
}

/** 去掉 id 上的 `mem_` 显示前缀。 */
export function bareId(value: string): string {
  return value.startsWith('mem_') ? value.slice(4) : value
}

/** 把 id 渲染成面向模型的文本。 */
export function displayId(id: string): string {
  return `mem_${id}`
}

/** 记忆正文中解析出来的一处 `[[link]]`。 */
export interface MemoryLinkRef {
  raw: string
  id?: string
  slug?: string
}

/** 从 Markdown 中提取 `[[...]]` 引用，并去重。 */
export function extractLinks(body: string): MemoryLinkRef[] {
  const out: MemoryLinkRef[] = []
  const seen = new Set<string>()
  const re = /\[\[([^[\]\n]{1,128})\]\]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(body)) !== null) {
    const raw = match[1]!.trim()
    if (raw.length === 0 || seen.has(raw)) continue
    seen.add(raw)
    const candidate = bareId(raw)
    if (isUlid(candidate)) out.push({ raw, id: candidate })
    else if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw)) out.push({ raw, slug: raw })
  }
  return out
}
