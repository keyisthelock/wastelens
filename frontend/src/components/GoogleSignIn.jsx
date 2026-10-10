import { useEffect, useRef, useState } from 'react'
import { accountRequest } from '../account-api.js'
import { googleChallenge, googleConfiguration, loadGoogleIdentity } from '../google-signin.js'

function GoogleMark() {
  return <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285F4" d="M43.6 24.5c0-1.5-.1-2.9-.4-4.3H24v8.2h11a9.4 9.4 0 0 1-4.1 6.2v5.1h6.6c3.9-3.6 6.1-8.9 6.1-15.2Z"/><path fill="#34A853" d="M24 44c5.5 0 10.1-1.8 13.5-4.3l-6.6-5.1c-1.8 1.2-4.1 1.9-6.9 1.9-5.3 0-9.8-3.6-11.4-8.4H5.8v5.3A20 20 0 0 0 24 44Z"/><path fill="#FBBC05" d="M12.6 28.1a12 12 0 0 1 0-8.2v-5.3H5.8a20 20 0 0 0 0 18.8l6.8-5.3Z"/><path fill="#EA4335" d="M24 11.5c3 0 5.6 1 7.7 3l5.8-5.8A19.3 19.3 0 0 0 24 4 20 20 0 0 0 5.8 14.6l6.8 5.3c1.6-4.8 6.1-8.4 11.4-8.4Z"/></svg>
}

export default function GoogleSignIn({ api, disabled, onAccount, onBusyChange }) {
  const [phase, setPhase] = useState('loading')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const host = useRef(null)
  const handlers = useRef({ onAccount, onBusyChange, disabled })
  handlers.current = { onAccount, onBusyChange, disabled }
  useEffect(() => {
    let active = true, busy = false, expiry
    const prepare = async () => {
      setPhase('loading'); setError('')
      try {
        const config = await googleConfiguration(fetch, api)
        if (!active) return
        if (!config.configured) { setPhase('unconfigured'); return }
        const identity = await loadGoogleIdentity()
        if (!active) return
        const challenge = await googleChallenge(fetch, api)
        if (!active || !host.current) return
        identity.initialize({ client_id: config.client_id, nonce: challenge.nonce,
          auto_select: false, ux_mode: 'popup', callback: async (value) => {
            if (!active || busy || handlers.current.disabled) return
            busy = true; window.clearTimeout(expiry); handlers.current.onBusyChange(true)
            setPhase('verifying'); setError('')
            try {
              if (typeof value?.credential !== 'string') throw new Error('Google did not confirm sign-in. Please try again.')
              const user = await accountRequest(fetch, api, 'google', { credential: value.credential })
              if (active) { handlers.current.onAccount(user); window.location.hash = 'community' }
            } catch (e) {
              if (active) { setError(e.message); setPhase('error') }
            } finally { busy = false; handlers.current.onBusyChange(false) }
          },
        })
        host.current.replaceChildren()
        identity.renderButton(host.current, { type: 'standard', theme: 'outline', size: 'large',
          text: 'continue_with', shape: 'pill', width: Math.min(400, Math.max(220, host.current.parentElement.clientWidth || 280)),
        })
        setPhase('ready')
        expiry = window.setTimeout(() => {
          if (active && !busy) { setError('Google sign-in expired. Tap Try Google again to refresh it.'); setPhase('error') }
        }, challenge.expires_in * 1000)
      } catch (e) { if (active) { setError(e.message); setPhase('error') } }
    }
    void prepare()
    return () => { active = false; window.clearTimeout(expiry); host.current?.replaceChildren() }
  }, [api, attempt])
  return <div className="google-signin">
    <div ref={host} className={`google-button-host ${phase !== 'ready' || disabled ? 'google-hidden' : ''}`} aria-hidden={phase !== 'ready' || disabled}/>
    {(phase !== 'ready' || disabled) && <button type="button" className="google-placeholder" disabled><GoogleMark/>{phase === 'verifying' ? 'Confirming Google sign-in…' : 'Continue with Google'}</button>}
    {phase === 'loading' && <small role="status">Checking Google sign-in…</small>}
    {phase === 'unconfigured' && <small role="status">Google sign-in is not enabled yet. You can use email or continue as a guest.</small>}
    {error && <><p className="tool-error" role="alert">{error}</p><button type="button" className="google-retry" disabled={disabled} onClick={() => setAttempt((value) => value + 1)}>Try Google again</button></>}
    <div className="account-divider"><span>or use email</span></div>
  </div>
}
