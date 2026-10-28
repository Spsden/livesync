export function uid(bytes = 8): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2)
  const letters = parts.map((part) => part[0] ?? '').join('')
  return (letters || '?').toUpperCase()
}

const PALETTE = [
  '#5b8cff',
  '#f0883e',
  '#3fb950',
  '#db61a2',
  '#a371f7',
  '#e3b341',
  '#39c5cf',
  '#f85149',
]

export function pickColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  }
  return PALETTE[hash % PALETTE.length] ?? PALETTE[0]!
}

const ADJECTIVES = [
  'quiet', 'brave', 'lucky', 'rapid', 'clever', 'gentle', 'solid', 'bright',
  'calm', 'witty', 'swift', 'kind', 'bold', 'neat', 'plain', 'silent',
]

const ANIMALS = [
  'otter', 'heron', 'lynx', 'moth', 'panda', 'raven', 'slug', 'tapir',
  'vole', 'wren', 'yak', 'zebu', 'finch', 'gecko', 'hare', 'ibis',
]

export function randomName(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)]
  return `${adjective} ${animal}`
}
