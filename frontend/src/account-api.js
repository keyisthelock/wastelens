import { requestJson } from './report-workflow.js'

export function validAccount(value) {
  if (!value || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || !value.name || typeof value.email !== 'string') {
    throw new Error('Sign-in could not be confirmed. Please try signing in again.')
  }
  return value
}
export async function accountRequest(fetchImpl, api, action, details) {
  const response = await requestJson(fetchImpl, `${api}/auth/${action}`, {
    credentials: 'include',
    ...(details ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(details) } : {}),
  }, 'Your account could not connect. Please try again.')
  if (action === 'logout') {
    if (response.signed_out !== true) throw new Error('Sign-out was not confirmed. Please try again.')
    return null
  }
  if (action === 'me' && response.user === null) return null
  return validAccount(response.user)
}
