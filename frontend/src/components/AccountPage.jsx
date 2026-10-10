import { useState } from 'react'
import { ArrowRight, Leaf, Mail, LockKeyhole, Users, Eye, EyeOff, LogOut } from 'lucide-react'
import LogoMark from './LogoMark.jsx'
import { accountRequest } from '../account-api.js'
import GoogleSignIn from './GoogleSignIn.jsx'

export default function AccountPage({ api, user, onAccount }) {
  const [mode, setMode] = useState('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event) => {
    event.preventDefault(); if (busy) return
    setBusy(true); setError('')
    try {
      const account = await accountRequest(fetch, api, mode === 'register' ? 'register' : 'login', { email, password, ...(mode === 'register' ? { name } : {}) })
      onAccount(account); setPassword(''); window.location.hash = 'community'
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }
  const logout = async () => {
    setBusy(true); setError('')
    try { await accountRequest(fetch, api, 'logout', {}); onAccount(null) }
    catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }
  return <section className="account-page" aria-label="WasteLens account">
    <div className="account-story"><span className="eyebrow">GOOD PEOPLE. GREENER PLACES.</span><h1>A cleaner city<br/>starts with <em>us.</em></h1><p>Meet the neighbors who notice. Share a sighting, start a conversation, and give your street a little more care.</p><div className="account-art" aria-hidden="true"><span className="account-orbit"/><span className="account-orbit orbit-two"/><div className="account-logo"><LogoMark/></div><span className="account-sticker sticker-leaf"><Leaf size={26}/> A little greener</span><span className="account-sticker sticker-people"><Users size={25}/> Better, together</span><i>✳</i></div><div className="account-story-foot">LUCKNOW PILOT <span>✳</span> EVERY NEIGHBOR COUNTS</div></div>
    <div className="account-form-wrap">{user ? <><span className="eyebrow muted">YOUR WASTELENS ACCOUNT</span><h2>Hey, {user.name}.</h2><p>You’re signed in as {user.email}.</p><a className="button button-green" href="#community">Back to your neighborhood <ArrowRight size={16}/></a><a className="account-secondary" href="#groups">Explore communities</a><button className="button button-outline" disabled={busy} onClick={logout}><LogOut size={16}/>{busy ? 'Signing out…' : 'Sign out'}</button></> : <><div className="account-tabs" aria-label="Account options"><button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError('') }} disabled={busy}>Log in</button><button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => { setMode('register'); setError('') }} disabled={busy}>Create account</button></div><span className="eyebrow muted">YOUR NEIGHBORHOOD IS WAITING</span><h2>{mode === 'login' ? 'Welcome back.' : 'Find your people.'}</h2><p>{mode === 'login' ? 'Pick up where you left off. A better block is a shared effort.' : 'Join WasteLens and take your first step toward a cleaner neighborhood.'}</p><GoogleSignIn api={api} disabled={busy} onAccount={onAccount} onBusyChange={setBusy}/><form onSubmit={submit}>
      {mode === 'register' && <label>Display name<div className="account-input"><Users size={17}/><input required minLength={2} maxLength={40} autoComplete="nickname" value={name} onChange={(e) => setName(e.target.value)} placeholder="What should we call you?" disabled={busy}/></div></label>}
      <label>Email address<div className="account-input"><Mail size={17}/><input type="email" required maxLength={254} autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" disabled={busy}/></div></label>
      <label>Password<div className="account-input"><LockKeyhole size={17}/><input type={visible ? 'text' : 'password'} required minLength={mode === 'register' ? 12 : 1} maxLength={128} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === 'register' ? 'At least 12 characters' : 'Your password'} disabled={busy}/><button type="button" onClick={() => setVisible(!visible)} aria-label={visible ? 'Hide password' : 'Show password'}>{visible ? <EyeOff size={17}/> : <Eye size={17}/>}</button></div></label>
      <button className="button button-dark account-submit" disabled={busy}>{busy ? 'Connecting…' : mode === 'register' ? 'Create my account' : 'Log in'} {!busy && <ArrowRight size={17}/>}</button>
    </form><a className="guest-link" href="#community">Just looking? Explore as a guest <ArrowRight size={14}/></a><small className="account-limits">Email verification and password recovery are not available for password accounts in this pilot. Use a unique password. Guest report editing stays with the browser you used.</small></>}{error && <p className="tool-error" role="alert">{error}</p>}</div>
  </section>
}
