import { create } from '@storacha/client'
import { StoreConf } from '@storacha/client/stores/conf'

/**
 * Try to load existing Storacha credentials.
 * Checks own profile first, then falls back to shared CLI profile.
 * Returns info about what's available.
 */
export async function detectCredentials() {
  const profiles = ['storacha-export', 'storacha-cli']

  for (const profile of profiles) {
    try {
      const store = new StoreConf({ profile })
      const client = await create({ store })

      const accounts = Object.entries(client.accounts())
      if (accounts.length === 0) continue

      const spaces = client.spaces().map(s => ({
        did: s.did(),
        name: s.name || '(unnamed)',
      }))

      return {
        hasCredentials: true,
        profile,
        accounts: accounts.map(([email]) => email),
        spaces,
        client,
      }
    } catch {
      continue
    }
  }

  return { hasCredentials: false, profile: null, spaces: [], accounts: [], client: null }
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
