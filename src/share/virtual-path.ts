/**
 * Shared files are advertised to peers with Windows style paths, whatever the backend they
 * come from. Every path handled by a share provider or by the index is normalized to that
 * form: '\' separated, no leading or trailing separator.
 */
export const SEPARATOR = '\\'

/** Normalizes a path to the form advertised to peers: 'music\Artist\song.mp3' */
export function normalize (path: string): string {
  return path
    .split(/[/\\]+/)
    .filter(segment => segment.length > 0 && segment !== '.')
    .join(SEPARATOR)
}

/** Folder containing the file, empty string for a file at the root of a share */
export function folderOf (path: string): string {
  const index = path.lastIndexOf(SEPARATOR)
  return index === -1 ? '' : path.substring(0, index)
}

/** Last segment of the path */
export function baseNameOf (path: string): string {
  const index = path.lastIndexOf(SEPARATOR)
  return index === -1 ? path : path.substring(index + 1)
}

/** Extension without its dot, as sent in file entries, empty when the file has none */
export function extensionOf (path: string): string {
  const name = baseNameOf(path)
  const index = name.lastIndexOf('.')
  return index <= 0 ? '' : name.substring(index + 1)
}
