import type { UploadQueue } from '../core/queue.js'
import type { ExportBackend } from '../backends/interface.js'
import { log } from '../util/log.js'

export interface VerifyOptions {
  queue: UploadQueue
  backends: ExportBackend[]
  onProgress?: (info: { type: string; [key: string]: any }) => void
}

export interface VerifyResult {
  verified: number
  failed: number
  errors: Array<{ rootCid: string; backend: string; error: string }>
}

export async function runVerify(options: VerifyOptions): Promise<VerifyResult> {
  const { queue, backends, onProgress } = options
  let verified = 0
  let failed = 0
  const errors: VerifyResult['errors'] = []

  for (const backend of backends) {
    const complete = queue.getComplete(backend.name)

    log('VERIFY', `Checking ${complete.length} complete uploads in ${backend.name}`)

    for (const upload of complete) {
      const tag = `[${upload.space_name}] ${upload.root_cid.slice(0, 24)}...`
      onProgress?.({ type: 'verifying', rootCid: upload.root_cid, spaceName: upload.space_name })

      try {
        let valid: boolean
        let error: string | undefined

        if (backend.verifyDag) {
          const result = await backend.verifyDag(upload.root_cid)
          valid = result.valid
          error = result.error
        } else {
          valid = await backend.hasContent(upload.root_cid)
          if (!valid) error = 'Content not found'
        }

        if (valid) {
          verified++
          onProgress?.({ type: 'verified', rootCid: upload.root_cid })
        } else {
          failed++
          log('VERIFY', `${tag} FAILED: ${error}`)
          queue.setStatus(upload.root_cid, backend.name, 'partial')
          errors.push({ rootCid: upload.root_cid, backend: backend.name, error: error || 'unknown' })
          onProgress?.({ type: 'verify-failed', rootCid: upload.root_cid, error })
        }
      } catch (err: any) {
        failed++
        log('VERIFY', `${tag} ERROR: ${err.message}`)
        queue.setStatus(upload.root_cid, backend.name, 'partial')
        errors.push({ rootCid: upload.root_cid, backend: backend.name, error: err.message })
      }
    }
  }

  log('VERIFY', `Complete: ${verified} verified, ${failed} failed`)
  return { verified, failed, errors }
}
