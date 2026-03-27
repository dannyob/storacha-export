/**
 * Enumerate all uploads across selected spaces.
 * Yields { rootCid, spaceDid, spaceName } for each upload.
 *
 * @param {import('@storacha/client').Client} client
 * @param {Array<{did: string, name: string}>} spaces
 * @param {object} [options]
 * @param {(msg: string) => void} [options.onProgress]
 */
export async function* enumerateUploads(client, spaces, options = {}) {
  const { onProgress } = options

  for (const space of spaces) {
    onProgress?.(`Enumerating ${space.name}...`)
    client.setCurrentSpace(space.did)

    let cursor
    let pageCount = 0

    do {
      const listOptions = { cursor }
      const result = await client.capability.upload.list(listOptions)

      for (const upload of result.results) {
        yield {
          rootCid: upload.root.toString(),
          spaceDid: space.did,
          spaceName: space.name,
        }
      }

      pageCount += result.results.length
      onProgress?.(`  ${space.name}: ${pageCount} uploads found...`)

      cursor = result.cursor
    } while (cursor)

    onProgress?.(`  ${space.name}: ${pageCount} uploads total`)
  }
}
