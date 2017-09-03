const slsk = require('./index.js')

slsk.connect({
  user: 'IAmWebServer',
  pass: 'IAmPassword'
}, (err, client) => {
  if (err) return console.log(err)
  console.log(client)
})
