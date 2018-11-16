module.exports = (str, query) => {
  let toBeMatched = str.toLowerCase()
  return query.toLowerCase().split(' ')
    .map(criterion => criterion.startsWith('-')
      ? toBeMatched.indexOf(criterion.substring(1)) === -1
      : toBeMatched.indexOf(criterion) !== -1)
    .reduce((a, b) => a && b, true)
}
