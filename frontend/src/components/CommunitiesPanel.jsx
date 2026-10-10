import { useEffect, useState } from 'react'
import { Users, Plus, RefreshCw } from 'lucide-react'
import { requestJson } from '../report-workflow.js'

export default function CommunitiesPanel({ api, getClientToken, registration = false, compact = false, user = null }) {
  const [groups, setGroups] = useState([])
  const [open, setOpen] = useState(registration)
  const [form, setForm] = useState({ name: '', area: '', description: '', creator: user?.name || '' })
  const [attempt, setAttempt] = useState(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const refresh = async () => {
    setLoading(true)
    try {
      const result = await requestJson(fetch, `${api}/communities`, {}, 'Communities could not load. Try refreshing.')
      if (!Array.isArray(result.communities)) throw new Error('The community list could not be read.')
      setGroups(result.communities); setError('')
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { void refresh() }, [])
  const create = async (event) => {
    event.preventDefault()
    if (busy) return
    const current = attempt || { ...form, creator: form.creator.trim() || 'Neighbor', id: crypto.randomUUID() }
    setAttempt(current); setBusy(true); setError(''); setNotice('')
    try {
      const result = await requestJson(fetch, `${api}/communities`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client-Token': getClientToken() },
        body: JSON.stringify(current),
      }, 'Creation could not be confirmed. Retry these same details safely.')
      if (result.community?.id !== current.id) throw new Error('Community creation was not confirmed. Retry safely.')
      setGroups((items) => [result.community, ...items.filter((item) => item.id !== current.id)])
      setForm({ name: '', area: '', description: '', creator: user?.name || '' }); setAttempt(null); setOpen(false)
      setNotice('Community created. Neighbors can now discover it here.')
    } catch (e) {
      if ([400, 401, 403, 409, 422].includes(e.status)) setAttempt(null)
      setError(e.message)
    } finally { setBusy(false) }
  }
  const field = (key, value) => setForm((item) => ({ ...item, [key]: value }))
  return <aside className={`city-communities${registration && open ? ' registration-open' : ''}`} aria-label={registration ? "Community registration" : "Lucknow communities"}>
    <div className="communities-heading"><div><span className="eyebrow muted">YOUR PEOPLE. YOUR CITY.</span><h3><Users size={21}/> {registration ? 'Register your community' : 'Lucknow communities'}</h3></div><button className="icon-button" disabled={loading || busy} onClick={refresh} aria-label="Refresh communities"><RefreshCw size={16}/></button></div>
    <p>Find neighbors who care about your corner of the city. Start a group around a shared cleanup goal.</p>
    {compact ? <a className="button button-dark" href="#groups"><Plus size={15}/> Discover & register communities</a> : <button className="button button-dark" onClick={() => setOpen(!open)} disabled={busy} aria-expanded={open}><Plus size={15}/>{open ? 'Browse communities' : 'Register a community'}</button>}
    {open && !compact && <form className="community-create" onSubmit={create}>
      <label>Community name<input className="text-input" required minLength={2} maxLength={80} value={form.name} disabled={busy || Boolean(attempt)} onChange={(e) => field('name', e.target.value)} placeholder="e.g. Sarojini Nagar Clean Streets"/></label>
      <label>Lucknow locality<input className="text-input" required minLength={2} maxLength={100} value={form.area} disabled={busy || Boolean(attempt)} onChange={(e) => field('area', e.target.value)} placeholder="Neighborhood or area"/></label>
      <label>What brings you together?<textarea className="text-input" rows={3} required minLength={5} maxLength={600} value={form.description} disabled={busy || Boolean(attempt)} onChange={(e) => field('description', e.target.value)} placeholder="A shared goal and how neighbors can help"/></label>
      <label>Your public alias<input className="text-input" maxLength={40} value={form.creator} disabled={busy || Boolean(attempt)} onChange={(e) => field('creator', e.target.value)} placeholder="Neighbor"/></label>
      <small>These details are public. Keep phone numbers and exact home addresses out.</small>
      <button className="button button-green" disabled={busy}>{busy ? 'Creating…' : attempt ? 'Retry creation safely' : 'Register community'}</button>
    </form>}
    {loading && <p role="status">Loading communities…</p>}
    {error && <p className="tool-error" role="alert">{error}</p>}{notice && <p className="draft-message" role="status">{notice}</p>}
    {!loading && !groups.length && !error && <div className="communities-empty"><Users size={25}/><b>Start something local.</b><span>No communities yet. Yours could be the first.</span></div>}
    <div className="community-directory">{groups.map((group) => <details key={group.id} className="community-directory-card"><summary><span className="community-avatar">{group.name.slice(0, 1).toUpperCase()}</span><span><b>{group.name}</b><small>{group.area} · {group.city}</small></span></summary><p>{group.description}</p><small>Started by {group.creator} · resident-created, unverified</small><p className="community-action-note">Use the report comment boxes below to propose a next step together.</p></details>)}</div>
    <small className="community-directory-note">Resident-created groups, not verified municipal organizations. Showing up to 50 recent communities.</small>
  </aside>
}
