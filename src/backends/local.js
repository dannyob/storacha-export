import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

export class LocalBackend {
  constructor({ outputDir }) {
    this.name = 'local'
    this.outputDir = outputDir
  }

  async init() {
    fs.mkdirSync(this.outputDir, { recursive: true })
  }

  async hasContent(rootCid) {
    const filePath = path.join(this.outputDir, `${rootCid}.car`)
    return fs.existsSync(filePath)
  }

  async importCar(rootCid, stream) {
    const filePath = path.join(this.outputDir, `${rootCid}.car`)
    const dest = fs.createWriteStream(filePath)
    await pipeline(stream, dest)
  }

  async close() {}
}
