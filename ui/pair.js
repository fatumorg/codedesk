const form = document.getElementById('form')
const code = document.getElementById('code')
const err = document.getElementById('err')
form.addEventListener('submit', async e => {
  e.preventDefault()
  err.textContent = ''
  const r = await fetch('/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.value }) }).catch(() => null)
  if (r && r.status === 204) location.replace('/')
  else err.textContent = r ? 'That code did not work. Check the PC for a fresh one.' : 'Could not reach Codedesk.'
})
