// Storacha-themed farewell rooster

export function printRooster(stats) {
  if (stats) {
    console.log(`
🐔 Cock-a-doodle-done!

Exported ${stats.total} uploads across ${stats.spaces} spaces.
${stats.bytes} transferred to ${stats.backends}.

Farewell, Storacha. Your data lives on!
`)
  } else {
    console.log(`
🐔 Thanks for the memories, Storacha!

Your data is safe now. All uploads exported successfully.
`)
  }
}
