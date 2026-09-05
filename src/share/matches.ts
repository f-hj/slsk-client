/**
 * Returns true when every criterion of the query matches the given string.
 * A criterion prefixed with '-' must NOT be contained in the string.
 * Matching is case-insensitive.
 */
export default function matches (str: string, query: string): boolean {
  const toBeMatched = str.toLowerCase()
  return query.toLowerCase().split(' ')
    .map(criterion => criterion.startsWith('-')
      ? !toBeMatched.includes(criterion.substring(1))
      : toBeMatched.includes(criterion))
    .reduce((a, b) => a && b, true)
}
