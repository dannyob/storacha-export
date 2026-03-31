export function filesize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
  return `${(bytes / 1024 ** 4).toFixed(1)} TiB`
}

export function formatEta(seconds: number): string {
  if (seconds <= 0) return ''
  if (seconds > 3600) return `${(seconds / 3600).toFixed(1)}h`
  return `${Math.round(seconds / 60)}m`
}
