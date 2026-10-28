/**
 * Where the app is mounted. Vite bakes `base` into the bundle, so this is a
 * build-time value: '' for the domain root, '/livesync' when served under a
 * path (see BASE_PATH in the environment / Dockerfile).
 */
export const BASE_PATH = import.meta.env.BASE_URL.replace(/\/+$/, '')

export function withBase(path: string): string {
  return `${BASE_PATH}${path}`
}
