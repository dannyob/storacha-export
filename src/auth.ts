import { create } from '@storacha/client'
import { StoreConf } from '@storacha/client/stores/conf'

export interface SpaceInfo {
  did: string
  name: string
}

export interface CredentialResult {
  hasCredentials: boolean
  profile: string | null
  accounts: string[]
  spaces: SpaceInfo[]
  client: any | null
}

export async function detectCredentials(): Promise<CredentialResult> {
  const profiles = ['storacha-export', 'storacha-cli']

  for (const profile of profiles) {
    try {
      const store = new StoreConf({ profile })
      const client = await create({ store })
      const accounts = Object.entries(client.accounts())
      if (accounts.length === 0) continue

      const spaces = client.spaces().map((s: any) => ({
        did: s.did(),
        name: s.name || '(unnamed)',
      }))

      return {
        hasCredentials: true,
        profile,
        accounts: accounts.map(([email]: [string, any]) => email),
        spaces,
        client,
      }
    } catch {
      continue
    }
  }

  return { hasCredentials: false, profile: null, spaces: [], accounts: [], client: null }
}

export async function login(email: string) {
  const store = new StoreConf({ profile: 'storacha-export' })
  const client = await create({ store })
  const account = await client.login(email)
  await account.plan.wait()
  return client
}
