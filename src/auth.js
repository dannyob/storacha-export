import { create } from '@storacha/client'
import { StoreConf } from '@storacha/client/stores/conf'

/**
 * Try to load existing Storacha credentials.
 * Returns info about what's available.
 */
export async function detectCredentials(storeName = 'storacha-cli') {
  try {
    const store = new StoreConf({ profile: storeName })
    const client = await create({ store })

    const accounts = Object.entries(client.accounts())
    if (accounts.length === 0) {
      return { hasCredentials: false, spaces: [], accounts: [], client: null }
    }

    const spaces = client.spaces().map(s => ({
      did: s.did(),
      name: s.name || '(unnamed)',
    }))

    return {
      hasCredentials: true,
      accounts: accounts.map(([email]) => email),
      spaces,
      client,
    }
  } catch {
    return { hasCredentials: false, spaces: [], accounts: [], client: null }
  }
}

/**
 * Run interactive login flow.
 * @param {string} email
 */
export async function login(email) {
  const store = new StoreConf({ profile: 'storacha-export' })
  const client = await create({ store })
  const account = await client.login(email)
  await account.plan.wait()
  return client
}
