import { requestJson } from './report-workflow.js'

let libraryPromise
export function loadGoogleIdentity() {
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id)
  if (libraryPromise) return libraryPromise
  libraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'; script.async = true
    const timer = window.setTimeout(() => failed(), 15000)
    const failed = () => {
      window.clearTimeout(timer); script.remove(); libraryPromise = null
      reject(new Error('Google sign-in could not load. Check your connection or use email sign-in.'))
    }
    script.onerror = failed
    script.onload = () => {
      window.clearTimeout(timer)
      if (window.google?.accounts?.id) resolve(window.google.accounts.id)
      else failed()
    }
    document.head.append(script)
  })
  return libraryPromise
}

export async function googleConfiguration(fetchImpl, api) {
  const value = await requestJson(fetchImpl, `${api}/auth/google/config`, { credentials: 'include' }, 'Google sign-in could not connect. Use email sign-in or try again.')
  if (typeof value.configured !== 'boolean' || (value.configured && !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(value.client_id || ''))) {
    throw new Error('Google sign-in setup could not be confirmed. Please use email sign-in.')
  }
  return value
}

export async function googleChallenge(fetchImpl, api) {
  const value = await requestJson(fetchImpl, `${api}/auth/google/challenge`, {
    credentials: 'include', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }, 'Google sign-in could not start. Please try again.')
  if (typeof value.nonce !== 'string' || value.nonce.length < 32 || !Number.isFinite(value.expires_in) || value.expires_in <= 0) {
    throw new Error('Google sign-in could not start safely. Please try again.')
  }
  return value
}
