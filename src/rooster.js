// Storacha-themed farewell rooster
// Inspired by the Storacha logo at https://storacha.network/

const ROOSTER = `
    .--.
   /  oo\\
  |  \\__/|     🐔 Thanks for the memories, Storacha!
   \\    / \\
    )  (   \\   Your data is safe now.
   /    \\   \\  All uploads exported successfully.
  /  /\\  \\   |
 (  /  \\  )  |
  \\/    \\/  /
   |      |  /
   |      |/
   |______|
   |  ||  |
   |  ||  |
   (__)(__)
`

const ROOSTER_WITH_STATS = (stats) => `
    .--.
   /  oo\\
  |  \\__/|     🐔 Cock-a-doodle-done!
   \\    / \\
    )  (   \\   Exported ${stats.total} uploads across ${stats.spaces} spaces.
   /    \\   \\  ${stats.bytes} transferred to ${stats.backends}.
  /  /\\  \\   |
 (  /  \\  )  | Farewell, Storacha. Your data lives on! 🌅
  \\/    \\/  /
   |      |  /
   |      |/
   |______|
   |  ||  |
   |  ||  |
   (__)(__)
`

export function printRooster(stats) {
  if (stats) {
    console.log(ROOSTER_WITH_STATS(stats))
  } else {
    console.log(ROOSTER)
  }
}
