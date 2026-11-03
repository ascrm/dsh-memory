import { copyFile, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const source = resolve(root, 'src/client.js')
const target = resolve(root, 'lib/client.js')

execFileSync(process.execPath, ['--check', source], { stdio: 'inherit' })
await mkdir(resolve(root, 'lib'), { recursive: true })
await copyFile(source, target)
console.log(`client bundle copied to ${target}`)
