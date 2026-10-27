// 对一个 mp4 套用 fixMp4Duration，用于本地复现/验证修复效果。
// 用法：node --experimental-strip-types scripts/apply-fix.mjs <输入> <输出> [真实时长秒]
import { readFileSync, writeFileSync } from 'node:fs'
import { fixMp4Duration } from '../src/mp4Duration.ts'

const [, , inFile, outFile, expected] = process.argv
if (!inFile || !outFile) {
  console.error('用法: node --experimental-strip-types scripts/apply-fix.mjs <输入> <输出> [时长]')
  process.exit(1)
}

const bytes = new Uint8Array(readFileSync(inFile))
const blob = new Blob([bytes], { type: 'video/mp4' })
const result = await fixMp4Duration(blob, expected ? Number(expected) : undefined)

console.log('changed:', result.changed)
console.log('target:', result.targetDuration.toFixed(3), 's  source:', result.source)
console.log('report:', result.report)

writeFileSync(outFile, new Uint8Array(await result.blob.arrayBuffer()))
console.log('已写出', outFile)
