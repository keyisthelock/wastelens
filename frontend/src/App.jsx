import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowRight, ArrowUpRight, Bot, Camera, Check, ChevronDown, CircleHelp, Clipboard, Clock3, Crosshair, FileText, Leaf, MapPin, MessageCircle, Printer, RefreshCw, ScanLine, Search, Send, ShieldCheck, Sparkles, ThumbsUp, UploadCloud, X } from 'lucide-react'
import CommunityMap from './components/CommunityMap.jsx'

const API = import.meta.env.VITE_API_URL || (['localhost', '127.0.0.1'].includes(window.location.hostname) ? 'http://localhost:8000/api' : '/api')
const API_BASE = API.replace(/\/api\/?$/, '')
const mediaUrl = (path) => path?.startsWith('http') ? path : `${API_BASE}${path || ''}`
const SEVERITY_RANK = { high: 3, medium: 2, low: 1, needs_review: 0, unassessed: 0 }
const relativeTime = (value) => {
  const minutes = Math.floor((Date.now() - new Date(value).getTime()) / 60000)
  if (!Number.isFinite(minutes) || minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
const clientToken = () => {
  let token = localStorage.getItem('wastelens-client-token')
  if (!token) { token = crypto.randomUUID(); localStorage.setItem('wastelens-client-token', token) }
  return token
}
const ownerToken = (reportId) => {
  try { return JSON.parse(sessionStorage.getItem('wastelens-owner-tokens') || '{}')[reportId] || '' }
  catch { return '' }
}
const rememberOwnerToken = (reportId, token) => {
  try {
    const tokens = JSON.parse(sessionStorage.getItem('wastelens-owner-tokens') || '{}')
    tokens[reportId] = token
    sessionStorage.setItem('wastelens-owner-tokens', JSON.stringify(tokens))
  } catch { /* The token remains in memory for the just-created report. */ }
}
const ownerHeaders = (reportId, headers = {}) => ownerToken(reportId)
  ? { ...headers, 'X-Report-Token': ownerToken(reportId) }
  : headers

const photoToSafeJpeg = async (file) => {
  const image = await createImageBitmap(file)
  const scale = Math.min(1, 1600 / Math.max(image.width, image.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.width * scale))
  canvas.height = Math.max(1, Math.round(image.height * scale))
  canvas.getContext('2d', { alpha: false }).drawImage(image, 0, 0, canvas.width, canvas.height)
  image.close?.()
  for (const quality of [0.84, 0.74, 0.64, 0.54]) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
    if (!blob) throw new Error('This photo could not be prepared for secure upload.')
    if (blob.size <= 4_800_000) return blob
  }
  throw new Error('This photo is too large after compression. Choose a smaller image.')
}

function App() {
  const [reports, setReports] = useState([])
  const [communityImpact, setCommunityImpact] = useState(null)
  const [securityStatus, setSecurityStatus] = useState(null)
  const [authorities, setAuthorities] = useState({ configured: false, authorities: [] })
  const [aiStatus, setAiStatus] = useState({ ready: false, message: 'Checking assistant…' })
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [selected, setSelected] = useState(null)
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [sortBy, setSortBy] = useState('newest')
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [assistantContext, setAssistantContext] = useState(null)
  const [assistantMessages, setAssistantMessages] = useState([
    { role: 'assistant', text: 'Hi, I’m your WasteLens field guide. I can route you to verified Lucknow contacts, current board totals, reporting steps, or a possible nearby-report check. My answers are limited to the pilot directory and community board.' },
  ])
  const [assistantInput, setAssistantInput] = useState('')
  const [assistantBusy, setAssistantBusy] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(null)
  const fileRef = useRef(null)
  const assistantEndRef = useRef(null)
  const toastTimer = useRef(null)
  const [photo, setPhoto] = useState(null)
  const [photoUrl, setPhotoUrl] = useState('')
  const [address, setAddress] = useState('')
  const [latitude, setLatitude] = useState('')
  const [longitude, setLongitude] = useState('')

  const refresh = async (quiet = false) => {
    if (!quiet) setRefreshing(true)
    try {
      const [reportsResponse, authorityResponse, aiResponse, impactResponse, securityResponse] = await Promise.all([
        fetch(`${API}/reports`),
        fetch(`${API}/authorities?city=Lucknow`),
        fetch(`${API}/ai/status`),
        fetch(`${API}/impact`),
        fetch(`${API}/security/status`),
      ])
      if (!reportsResponse.ok || !authorityResponse.ok) throw new Error('API unavailable')
      setReports(await reportsResponse.json())
      setAuthorities(await authorityResponse.json())
      if (aiResponse.ok) setAiStatus(await aiResponse.json())
      if (impactResponse.ok) setCommunityImpact(await impactResponse.json())
      if (securityResponse.ok) setSecurityStatus(await securityResponse.json())
      setLastUpdated(new Date())
      setError('')
    } catch {
      setError('Could not connect to the WasteLens API. Start the backend to load community reports.')
    } finally { setRefreshing(false) }
  }

  useEffect(() => {
    refresh()
    const interval = window.setInterval(() => refresh(true), 45000)
    return () => window.clearInterval(interval)
  }, [])
  useEffect(() => {
    if (!photo) { setPhotoUrl(''); return undefined }
    const objectUrl = URL.createObjectURL(photo)
    setPhotoUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [photo])
  useEffect(() => {
    assistantEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [assistantMessages, assistantBusy])
  useEffect(() => {
    if (!showForm && !selected && !assistantOpen) return undefined
    const hasModal = showForm || Boolean(selected)
    const previousOverflow = document.body.style.overflow
    if (hasModal) document.body.style.overflow = 'hidden'
    const closeOnEscape = (event) => {
      if (event.key !== 'Escape') return
      if (showForm) setShowForm(false)
      else if (selected) setSelected(null)
      else setAssistantOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      if (hasModal) document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [showForm, selected, assistantOpen])
  useEffect(() => {
    if (!('IntersectionObserver' in window)) {
      document.querySelectorAll('.reveal').forEach((node) => node.classList.add('is-visible'))
      return undefined
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target) }
      })
    }, { threshold: 0.12, rootMargin: '0px 0px -28px 0px' })
    document.querySelectorAll('.reveal:not(.is-visible)').forEach((node) => observer.observe(node))
    return () => observer.disconnect()
  }, [reports.length, showForm, selected, assistantOpen, categoryFilter, statusFilter, search])
  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  const flash = (message) => {
    setToast(message)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 3200)
  }
  const useLocation = () => {
    if (!navigator.geolocation) return setError('Location access is not available in this browser.')
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      setLatitude(coords.latitude.toFixed(6)); setLongitude(coords.longitude.toFixed(6)); setError('')
    }, () => setError('Location was not shared. Enter coordinates manually to continue.'))
  }
  const choosePhoto = (file) => {
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return setError('Choose a JPG, PNG, or WebP image.')
    if (file.size > 8 * 1024 * 1024) return setError('Choose an image smaller than 8 MB.')
    setError(''); setPhoto(file)
  }
  const submit = async (event) => {
    event.preventDefault(); setLoading(true); setError('')
    let pendingReportId = ''
    try {
      let report
      if (securityStatus?.cloud_storage_configured) {
        const jpeg = await photoToSafeJpeg(photo)
        const response = await fetch(`${API}/reports/upload-url`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ latitude: Number(latitude), longitude: Number(longitude), address }),
        })
        if (!response.ok) throw new Error((await response.json()).detail || 'Could not create report')
        const upload = await response.json()
        report = upload.report
        pendingReportId = report.id
        rememberOwnerToken(report.id, upload.owner_token)
        const sent = await fetch(upload.upload_url, {
          method: 'PUT', headers: { 'Content-Type': upload.upload_content_type }, body: jpeg,
        })
        if (!sent.ok) throw new Error('Photo upload failed. Please try again.')
        const confirmed = await fetch(`${API}/reports/${report.id}/confirm-upload`, {
          method: 'POST', headers: ownerHeaders(report.id),
        })
        if (!confirmed.ok) throw new Error((await confirmed.json()).detail || 'Photo verification failed')
        report = await confirmed.json()
        pendingReportId = ''
      } else {
        const body = new FormData()
        body.append('photo', photo); body.append('latitude', latitude); body.append('longitude', longitude); body.append('address', address)
        const response = await fetch(`${API}/reports`, { method: 'POST', body })
        if (!response.ok) throw new Error((await response.json()).detail || 'Could not create report')
        report = await response.json()
        rememberOwnerToken(report.id, report.owner_token)
        delete report.owner_token
      }
      const authHeaders = ownerHeaders(report.id)
      const analysis = await fetch(`${API}/reports/${report.id}/analyze`, { method: 'POST', headers: authHeaders })
      if (analysis.ok) report = (await analysis.json()).report
      const classification = await fetch(`${API}/reports/${report.id}/classify`, { method: 'POST', headers: ownerHeaders(report.id, { 'Content-Type': 'application/json' }), body: '{}' })
      if (classification.ok) {
        const result = await classification.json()
        report = result.report || report
      }
      const draftResponse = await fetch(`${API}/reports/${report.id}/complaint`, { method: 'POST', headers: ownerHeaders(report.id, { 'Content-Type': 'application/json' }), body: '{}' })
      if (draftResponse.ok) report = (await draftResponse.json()).report
      await refresh(true); setSelected(report); setShowForm(false); setPhoto(null); if (fileRef.current) fileRef.current.value = ''; setAddress(''); setLatitude(''); setLongitude('')
      flash('Your report is on the community board.')
    } catch (e) {
      if (pendingReportId) {
        await fetch(`${API}/reports/${pendingReportId}`, { method: 'DELETE', headers: ownerHeaders(pendingReportId) }).catch(() => {})
      }
      setError(e.message || 'Something went wrong. Please try again.')
    }
    finally { setLoading(false) }
  }
  const saveDraft = async (report, draft) => {
    const response = await fetch(`${API}/reports/${report.id}/complaint`, { method: 'POST', headers: ownerHeaders(report.id, { 'Content-Type': 'application/json' }), body: JSON.stringify({ draft }) })
    if (!response.ok) { setError('Could not save your complaint draft.'); return false }
    const result = await response.json(); setSelected(result.report); await refresh(true); flash('Complaint draft saved — still unsent.'); return true
  }
  const saveAssessment = async (report, categories, severity) => {
    const response = await fetch(`${API}/reports/${report.id}/analyze`, { method: 'POST', headers: ownerHeaders(report.id, { 'Content-Type': 'application/json' }), body: JSON.stringify({ categories, severity }) })
    if (!response.ok) { setError('Could not save the community assessment.'); return null }
    const updated = (await response.json()).report; setSelected(updated); await refresh(true); flash('Community assessment updated.'); return updated
  }
  const support = async (report) => {
    try {
      const response = await fetch(`${API}/reports/${report.id}/support`, { method: 'POST', headers: { 'X-Client-Token': clientToken() } })
      if (!response.ok) throw new Error()
      const result = await response.json()
      await refresh(true)
      if (selected?.id === report.id) setSelected(await (await fetch(`${API}/reports/${report.id}`, { headers: ownerHeaders(report.id) })).json())
      flash(result.supported ? 'You added your support. Thanks for showing up.' : 'Your support is already counted here.')
    } catch { setError('Could not register your support. Try refreshing the board.') }
  }
  const openReport = async (report) => {
    try {
      const response = await fetch(`${API}/reports/${report.id}`, { headers: ownerHeaders(report.id) })
      if (response.ok) setSelected(await response.json())
      else setSelected(report)
    } catch { setSelected(report) }
  }
  const askAboutReport = (report) => {
    setAssistantContext(report); setSelected(null); setAssistantOpen(true)
    setAssistantMessages((messages) => [...messages, { role: 'assistant', text: `I’m looking at report ${report.id.slice(0, 6).toUpperCase()}. I can check for nearby reports without sharing exact coordinates with the AI model.` }])
  }
  const askAssistant = async (event, preset) => {
    event?.preventDefault()
    const message = (preset || assistantInput).trim()
    if (!message || assistantBusy) return
    setAssistantMessages((items) => [...items, { role: 'user', text: message }]); setAssistantInput(''); setAssistantBusy(true)
    try {
      const response = await fetch(`${API}/assistant`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, report_id: assistantContext?.id || undefined }),
      })
      if (!response.ok) throw new Error('Assistant is temporarily unavailable.')
      const result = await response.json()
      setAssistantMessages((items) => [...items, {
        role: 'assistant', text: result.answer,
        mode: result.ai_used ? 'Strands · Bedrock intent routing' : 'Rules-based local guide',
      }])
    } catch (e) { setAssistantMessages((items) => [...items, { role: 'assistant', text: e.message || 'Please try that again.' }]) }
    finally { setAssistantBusy(false) }
  }

  const categories = [...new Set(reports.flatMap((report) => report.categories))].sort((a, b) => a.localeCompare(b))
  const filteredReports = reports.filter((report) => {
    const searchMatch = !search || [report.address, report.categories.join(' '), report.id, report.status].join(' ').toLowerCase().includes(search.toLowerCase())
    const categoryMatch = categoryFilter === 'all' || report.categories.some((category) => category.toLowerCase() === categoryFilter.toLowerCase())
    const statusMatch = statusFilter === 'all' || report.status === statusFilter
    return searchMatch && categoryMatch && statusMatch
  }).sort((a, b) => {
    if (sortBy === 'supported') return b.supports - a.supports || b.created_at.localeCompare(a.created_at)
    if (sortBy === 'severity') return (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0) || b.created_at.localeCompare(a.created_at)
    if (sortBy === 'oldest') return a.created_at.localeCompare(b.created_at)
    return b.created_at.localeCompare(a.created_at)
  })
  const totalSupports = reports.reduce((sum, report) => sum + report.supports, 0)
  const filtered = Boolean(search || categoryFilter !== 'all' || statusFilter !== 'all')
  const officialAuthority = authorities.authorities.find((authority) => authority.verified && authority.channels?.some((channel) => channel.type === 'web' && channel.url))
  const officialPortalUrl = officialAuthority?.channels.find((channel) => channel.type === 'web' && channel.url)?.url

  return <div className="page-shell" id="top">
    <header className="topbar"><a className="brand" href="#top"><span className="brand-mark"><Leaf size={18} strokeWidth={2.4}/></span><span>waste<span className="brand-light">lens</span></span></a><nav><a href="#community">Community</a><a href="#how">How it works</a><button className="nav-ai" onClick={() => setAssistantOpen(true)}><Sparkles size={14}/> Field guide</button></nav>{officialPortalUrl ? <a className="button button-dark top-cta" href={officialPortalUrl} target="_blank" rel="noreferrer"><ArrowUpRight size={15}/> Official LNN portal</a> : <span className="top-portal-unavailable">Municipal portal not configured</span>}</header>
    {error && <div className="notice" role="alert"><CircleHelp size={16}/>{error}<button onClick={() => setError('')} aria-label="Dismiss"><X size={15}/></button></div>}
    {toast && <div className="toast" role="status"><span><Check size={15}/></span>{toast}<button onClick={() => setToast('')} aria-label="Dismiss"><X size={14}/></button></div>}
    <main>
      <section className="hero">
        <div className="hero-copy"><div className="eyebrow hero-eyebrow"><span className="pulse-dot"/> LUCKNOW PILOT · CIVIC ACTION, MADE CLEARER</div><h1>See a mess.<br/><span>Make a difference.</span></h1><p className="hero-deck">A cleaner neighborhood begins with one report. Bring your community together to make sure no corner gets overlooked.</p><div className="hero-actions"><button className="button button-green" onClick={() => setShowForm(true)}>Report a waste site <ArrowRight size={17}/></button><a className="text-link" href="#community">Explore reports <ArrowDown size={15}/></a></div><div className="privacy-note"><ShieldCheck size={15}/> Location helps keep this pilot scoped to Lucknow</div></div>
        <div className="hero-visual"><div className="orb orb-one"/><div className="orb orb-two"/><div className="sun"/><div className="hill hill-back"/><div className="hill hill-front"/><div className="visual-label label-top"><ScanLine size={15}/> SPOT IT. REPORT IT.</div><div className="visual-label label-bottom"><span className="status-mini"/> LOCAL ACTION, BIG IMPACT</div><div className="visual-stamp"><span>SMALL ACTS</span><strong>ADD UP.</strong><Leaf size={21}/></div><div className="visual-spark spark-one">✳</div><div className="visual-spark spark-two">✳</div></div>
      </section>

      <section className="impact-strip reveal"><div><span className="metric">{reports.length.toString().padStart(2,'0')}</span><span className="metric-label">community reports</span></div><i/><div><span className="metric">{totalSupports.toString().padStart(2,'0')}</span><span className="metric-label">neighbors supporting</span></div><i/><div className="impact-message"><span className="impact-icon"><Leaf size={15}/></span><span>{communityImpact?.reports_with_estimate ? `${communityImpact.co2e_avoided_if_diverted_kg.min}–${communityImpact.co2e_avoided_if_diverted_kg.max} kg CO₂e` : 'No impact estimate yet'}<br/><b>estimated potential if diverted</b></span></div><span className="strip-star">✳</span></section>

      <section className="community-section" id="community"><div className="section-heading reveal"><div><div className="eyebrow muted">YOUR NEIGHBORHOOD, IN FOCUS</div><h2>Community <span>watchlist</span></h2></div><div className="heading-right"><span className="live-indicator"><span/> LIVE COMMUNITY BOARD</span></div></div>
        <div className="board-toolbar reveal"><div className="board-title"><span className="board-dot"/> RECENT SIGHTINGS <span className="count-pill">{filteredReports.length}<span className="count-total"> / {reports.length}</span></span></div><div className="board-controls"><label className="search-field"><Search size={15}/><input aria-label="Search community reports" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search reports"/>{search && <button aria-label="Clear search" onClick={() => setSearch('')}><X size={13}/></button>}</label><label className="status-filter"><span className="sr-only">Filter by status</span><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><option value="all">All statuses</option><option value="community_reported">New</option><option value="reviewed">Reviewed</option><option value="cleanup_confirmed">Cleanup confirmed</option></select><ChevronDown size={13}/></label><label className="sort-select"><span className="sr-only">Sort reports</span><select value={sortBy} onChange={(e) => setSortBy(e.target.value)}><option value="newest">Most recent</option><option value="oldest">Oldest first</option><option value="supported">Most supported</option><option value="severity">Highest severity</option></select><ChevronDown size={13}/></label><button className="refresh-button" onClick={() => refresh()} aria-label="Refresh reports" title={lastUpdated ? `Last updated ${lastUpdated.toLocaleTimeString()}` : 'Refresh reports'}><RefreshCw size={15} className={refreshing ? 'spin' : ''}/></button></div></div>
        {categories.length > 0 && <div className="category-filters reveal" aria-label="Filter reports by waste category"><button className={categoryFilter === 'all' ? 'filter-chip active' : 'filter-chip'} onClick={() => setCategoryFilter('all')}>All waste <span>{reports.length}</span></button>{categories.map((category) => <button key={category} className={categoryFilter === category ? 'filter-chip active' : 'filter-chip'} onClick={() => setCategoryFilter(categoryFilter === category ? 'all' : category)}>{category}</button>)}</div>}
        <section className="community-map-panel reveal" aria-label="Map of approximate community reports"><div className="community-map-title"><div><div className="eyebrow muted">LUCKNOW PILOT · APPROXIMATE REPORT LOCATIONS</div><h3>See what’s happening nearby</h3></div><span>{filteredReports.length} visible {filteredReports.length === 1 ? 'report' : 'reports'}</span></div><CommunityMap reports={filteredReports} onOpen={openReport}/><p className="map-privacy-note">Map pins use rounded locations. Exact addresses and report photos remain private to the reporter.</p></section>
        {reports.length === 0 ? <div className="empty-state reveal"><div className="empty-art"><div className="empty-ring ring-a"/><div className="empty-ring ring-b"/><span><Camera size={24}/></span><i>✳</i></div><div className="empty-copy"><span className="empty-kicker">A BETTER BLOCK STARTS HERE</span><h3>{error ? 'Your board is waiting to connect.' : 'Nothing on the board. Yet.'}</h3><p>Notice an overflowing bin, a vacant lot, or a forgotten corner? Start a community report from the introduction above; neighbors can support it here.</p></div><div className="empty-index">01 <span>—</span> 01</div></div> : filteredReports.length ? <div className="report-grid">{filteredReports.map((report, index) => <ReportCard key={report.id} report={report} index={index} onOpen={() => openReport(report)} onSupport={() => support(report)} onAsk={() => askAboutReport(report)}/>)}</div> : <div className="no-results reveal"><Search size={20}/><div><b>No reports match those filters.</b><span>Try another category or clear your search.</span></div><button className="button button-outline" onClick={() => { setSearch(''); setCategoryFilter('all'); setStatusFilter('all') }}>Clear filters</button></div>}
        <div className="board-foot"><span><span className="foot-dot"/> {reports.length ? `Showing ${filteredReports.length} of ${reports.length} community reports` : 'Waiting for the first neighborhood report'} · {lastUpdated ? `synced ${relativeTime(lastUpdated.toISOString())}` : 'syncing'}</span><span>ESTIMATES ARE LABELLED &nbsp;·&nbsp; COMMUNITY STATUS ONLY</span></div>
      </section>

      <section className="bottom-band reveal" id="how"><div className="bottom-spark">✳</div><div><span className="eyebrow">FROM SIGHTING TO SOLUTION</span><h2>Good things grow<br/>when we <em>show up.</em></h2></div><div className="steps"><div><span>01</span><b>Spot a waste site</b><small>Snap a photo and pin the location.</small></div><div><span>02</span><b>Get a clear next step</b><small>Review an editable complaint draft.</small></div><div><span>03</span><b>Bring others along</b><small>Support reports and reduce duplicates.</small></div></div></section>
      <div className="privacy-footer"><ShieldCheck size={13}/> Precise locations, photos and complaint drafts stay private to the reporter.</div>
    </main>
    <footer><a className="brand" href="#top"><span className="brand-mark"><Leaf size={16}/></span><span>waste<span className="brand-light">lens</span></span></a><span>Small acts. Cleaner streets.</span><span>COMMUNITY POWERED · ESTIMATE LABELLED</span></footer>

    {showForm && <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setShowForm(false)}><form className="modal report-modal" role="dialog" aria-modal="true" aria-labelledby="report-form-title" onSubmit={submit}><div className="modal-head"><div><div className="eyebrow muted">ADD TO THE COMMUNITY BOARD</div><h2 id="report-form-title">Report a waste site</h2></div><button type="button" className="icon-button" onClick={() => setShowForm(false)} aria-label="Close report form"><X size={19}/></button></div><label className={`upload-box ${photo ? 'has-photo' : ''}`} onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('dragging') }} onDragLeave={(e) => e.currentTarget.classList.remove('dragging')} onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove('dragging'); choosePhoto(e.dataTransfer.files[0]) }}>{photo ? <><img src={photoUrl} alt="Selected report preview"/><span className="upload-caption"><Check size={16}/>{photo.name}<small>Click or drop to choose another photo</small></span></> : <><UploadCloud size={23}/><b>Drop a photo or browse files</b><small>JPG, PNG or WebP · max 8 MB</small></>}<input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" required onChange={(e) => choosePhoto(e.target.files[0])}/></label><label className="field-label">LOCATION · LUCKNOW PILOT <button type="button" className="locate-link" onClick={useLocation}><Crosshair size={13}/> Use my location</button></label><input required value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street, landmark or neighborhood in Lucknow" className="text-input"/><div className="coordinate-row"><input required type="number" step="any" value={latitude} onChange={(e) => setLatitude(e.target.value)} placeholder="Latitude" className="text-input"/><input required type="number" step="any" value={longitude} onChange={(e) => setLongitude(e.target.value)} placeholder="Longitude" className="text-input"/></div><label className="jurisdiction-check"><input type="checkbox" required/><span>I confirm this site is within Lucknow Nagar Nigam’s jurisdiction.</span></label><div className="form-foot"><span><ShieldCheck size={14}/> Nothing is sent to an authority</span><button className="button button-green" disabled={loading || !photo}>{loading ? <><span className="button-loader"/> Creating report…</> : <>Create community report <ArrowRight size={15}/></>}</button></div></form></div>}
    {selected && <ReportDetail report={selected} onClose={() => setSelected(null)} onSave={saveDraft} onAssess={saveAssessment} onSupport={support} onAsk={() => askAboutReport(selected)}/>}
    {assistantOpen && <AssistantPanel status={aiStatus} messages={assistantMessages} input={assistantInput} busy={assistantBusy} context={assistantContext} endRef={assistantEndRef} onClose={() => setAssistantOpen(false)} onInput={setAssistantInput} onSubmit={askAssistant} onClearContext={() => setAssistantContext(null)}/>}
    {!assistantOpen && <button className="assistant-fab" onClick={() => setAssistantOpen(true)} aria-label="Open WasteLens field guide"><span className="fab-orbit"/><Sparkles size={17}/><span>Ask WasteLens</span><i className={aiStatus.ready ? 'ai-indicator ready' : 'ai-indicator'}/></button>}
  </div>
}

function ReportCard({ report, index, onOpen, onSupport, onAsk }) {
  const colors = ['#e9e6d7','#d9e3cf','#e4d9cd','#d9e1dc']
  const impact = report.impact?.co2e_avoided_if_diverted_kg
  return <article className="report-card reveal" style={{ '--card-delay': `${Math.min(index, 5) * 70}ms` }}><button className="card-image" onClick={onOpen} style={{ backgroundColor: colors[index % colors.length] }} aria-label={`Open report at ${report.address || 'reported location'}`}>{report.image_path ? <img src={mediaUrl(report.image_path)} alt="Reported unmanaged waste"/> : <span className="private-photo-placeholder"><ShieldCheck size={17}/> Photo visible to reporter only</span>}<span className="card-id">WL · {report.id.slice(0, 5).toUpperCase()}</span><span className="open-card"><ArrowUpRight size={17}/></span></button><div className="card-info"><button className="card-location location-link" onClick={onOpen}><MapPin size={13}/><span>{report.address || `${report.latitude.toFixed(2)}, ${report.longitude.toFixed(2)} · approximate`}</span></button><h3>{report.categories.length ? report.categories.join(', ') : 'Unmanaged waste'}</h3><div className="card-tags"><span className={`severity severity-${report.severity}`}>{report.severity.replace('_', ' ')}</span><span className="status-tag"><Clock3 size={12}/>{report.status.replaceAll('_', ' ')}</span><span className="report-age">{relativeTime(report.created_at)}</span></div><div className="card-bottom"><span className="estimate">{impact ? `Est. ${impact.min}–${impact.max} kg CO₂e if diverted` : 'Impact estimate not configured'}</span><div className="card-actions"><button className="ask-card" onClick={onAsk} aria-label="Ask the field guide about this report" title="Check for nearby duplicates"><Sparkles size={13}/></button><button className="support-button" onClick={onSupport}><ThumbsUp size={14}/>{report.supports}</button></div></div></div></article>
}

function ReportDetail({ report: initial, onClose, onSave, onAssess, onSupport, onAsk }) {
  const [report, setReport] = useState(initial)
  const [draft, setDraft] = useState(initial.complaint || '')
  const [saving, setSaving] = useState(false)
  const [categories, setCategories] = useState((initial.categories || []).join(', '))
  const [severity, setSeverity] = useState(initial.severity || 'unassessed')
  const [materialCategory, setMaterialCategory] = useState(initial.material_category || 'mixed')
  const [massClass, setMassClass] = useState(initial.mass_class || 'small')
  const [classificationNote, setClassificationNote] = useState(initial.analysis_note || '')
  const [draftMessage, setDraftMessage] = useState('')
  const [authorityMatch, setAuthorityMatch] = useState({ configured: false, authorities: [] })
  const [detailPhotoUrl, setDetailPhotoUrl] = useState('')
  useEffect(() => { setReport(initial); setDraft(initial.complaint || ''); setCategories((initial.categories || []).join(', ')); setSeverity(initial.severity || 'unassessed'); setMaterialCategory(initial.material_category || 'mixed'); setMassClass(initial.mass_class || 'small'); setClassificationNote(initial.analysis_note || '') }, [initial])
  useEffect(() => {
    let active = true
    let objectUrl = ''
    if (!initial.is_owner_view || !initial.image_path) { setDetailPhotoUrl(''); return undefined }
    const source = mediaUrl(initial.image_path)
    if (/^https?:\/\//i.test(initial.image_path)) { setDetailPhotoUrl(source); return undefined }
    fetch(source, { headers: ownerHeaders(initial.id) })
      .then((response) => response.ok ? response.blob() : Promise.reject(new Error('Photo is private')))
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob)
        if (active) setDetailPhotoUrl(objectUrl)
      })
      .catch(() => { if (active) setDetailPhotoUrl('') })
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [initial.id, initial.image_path, initial.is_owner_view])
  useEffect(() => {
    let active = true
    fetch(`${API}/authorities?latitude=${initial.latitude}&longitude=${initial.longitude}`)
      .then((response) => response.ok ? response.json() : null)
      .then((result) => { if (active && result) setAuthorityMatch(result) })
      .catch(() => { if (active) setAuthorityMatch({ configured: false, authorities: [] }) })
    return () => { active = false }
  }, [initial.id, initial.latitude, initial.longitude])
  const authority = authorityMatch.configured && authorityMatch.authorities.length ? authorityMatch.authorities[0] : null
  const saveAssessment = async () => {
    setSaving(true)
    const updated = await onAssess(report, categories.split(',').map((value) => value.trim()).filter(Boolean), severity)
    if (updated) setReport(updated)
    setSaving(false)
  }
  const saveDraft = async () => { setSaving(true); await onSave(report, draft); setSaving(false) }
  const copyDraft = async () => {
    try { await navigator.clipboard.writeText(draft); setDraftMessage('Draft copied. It has not been sent.') }
    catch { setDraftMessage('Clipboard access is unavailable here; select and copy the draft text.') }
  }
  const printDraft = () => {
    const body = document.body
    body.classList.add('printing-complaint')
    const cleanup = () => body.classList.remove('printing-complaint')
    window.addEventListener('afterprint', cleanup, { once: true })
    window.print()
    window.setTimeout(cleanup, 1500)
  }
  const runPhotoClassification = async () => {
    setSaving(true)
    try {
      const response = await fetch(`${API}/reports/${report.id}/classify`, { method: 'POST', headers: ownerHeaders(report.id, { 'Content-Type': 'application/json' }), body: '{}' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Photo classification failed')
      setClassificationNote(result.note || '')
      if (result.classification) { setMaterialCategory(result.classification.material_category); setMassClass(result.classification.mass_class) }
      if (result.report) setReport(result.report)
      else if (!result.analysis_available) setClassificationNote(result.note || 'Bedrock is not configured; select a category for a local estimate.')
    } catch (error) { setClassificationNote(error.message || 'Classification is unavailable.') }
    finally { setSaving(false) }
  }
  const saveRecoveryChoice = async () => {
    setSaving(true)
    try {
      const response = await fetch(`${API}/reports/${report.id}/classify`, { method: 'POST', headers: ownerHeaders(report.id, { 'Content-Type': 'application/json' }), body: JSON.stringify({ material_category_override: materialCategory, mass_class_override: massClass }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Could not save your category')
      setReport(result.report); setClassificationNote(result.note)
    } catch (error) { setClassificationNote(error.message || 'Could not save your category.') }
    finally { setSaving(false) }
  }
  const impact = report.impact?.co2e_avoided_if_diverted_kg
  const route = report.recovery_route
  const categoryLabels = { wet_organic: 'Wet / organic', dry_recyclable: 'Dry recyclable', e_waste: 'E-waste', hazardous: 'Hazardous household waste', mixed: 'Mixed or uncertain' }
  return <div className="modal-backdrop detail-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <div className="detail-modal">
      <div className="detail-top"><div className="eyebrow muted">COMMUNITY REPORT · {report.id.slice(0, 8).toUpperCase()}</div><button className="icon-button" onClick={onClose} aria-label="Close report details"><X size={19}/></button></div>
      <div className="detail-grid">{detailPhotoUrl ? <img className="detail-photo" src={detailPhotoUrl} alt="Reported waste site"/> : <div className="detail-photo private-photo-placeholder"><ShieldCheck size={18}/>{report.is_owner_view ? 'Loading private photo…' : 'Photo visible to reporter only'}</div>}<div className="detail-content"><div className="card-location"><MapPin size={14}/>{report.address || `${report.latitude}, ${report.longitude} · approximate`}</div><h2>{report.categories.length ? report.categories.join(', ') : 'Unmanaged waste'}</h2><div className="card-tags"><span className={`severity severity-${report.severity}`}>{report.severity.replace('_', ' ')}</span><span className="status-tag">{report.status.replaceAll('_', ' ')}</span></div><p className="analysis-note"><Sparkles size={14}/>{classificationNote || 'AI suggestions are optional and require resident review. No cleanup cost is estimated.'}</p><div className="detail-actions"><button className="button button-outline support-wide" onClick={() => onSupport(report)}><ThumbsUp size={15}/> Support this report · {report.supports}</button><button className="button button-outline" onClick={onAsk} title="Use the field guide to look for possible duplicates"><Sparkles size={15}/> Check nearby</button></div></div></div>
      <section className="recovery-panel"><div className="recovery-heading"><div><div className="eyebrow muted">WASTE → RECYCLE / ENERGY</div><h3>Check the material and route</h3></div>{report.is_owner_view && <button className="button button-outline" disabled={saving} onClick={runPhotoClassification}>{saving ? <><span className="button-loader"/> Checking…</> : <><Sparkles size={14}/> Analyze photo with Bedrock</>}</button>}</div>
        <p className="recovery-explainer">Bedrock output is an AI suggestion. Review the category and rough visual mass class before using it. {report.is_owner_view ? '' : 'This is a public summary; exact location and edit controls are private to the reporter.'}</p>
        {report.is_owner_view && <><div className="recovery-controls"><label className="field-label">MATERIAL CATEGORY<select className="text-input" value={materialCategory} onChange={(e) => setMaterialCategory(e.target.value)}>{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="field-label">ROUGH MASS ESTIMATE<select className="text-input" value={massClass} onChange={(e) => setMassClass(e.target.value)}><option value="small">Small · 1–5 kg</option><option value="medium">Medium · 5–25 kg</option><option value="large">Large · 25–100 kg</option></select></label></div><div className="assessment-footer"><span>Illustrative class only. Confirm category and weight in person.</span><button className="button button-green" disabled={saving} onClick={saveRecoveryChoice}>{saving ? 'Saving…' : <>Save resident review <Check size={14}/></>}</button></div></>}
        {report.classification && <p className="analysis-note"><Sparkles size={14}/>{report.classification.visual_note} · {report.classification.review_required ? 'AI suggestion; review required.' : 'Resident reviewed.'}</p>}
        {route && <div className="route-card"><div><b>{route.title}</b><span>{route.advice}</span><small>Availability: {route.availability.replaceAll('_', ' ')} · sourced {route.verified_on}</small><a href={route.source_url} target="_blank" rel="noreferrer">Review source ↗</a>{route.url && <a href={route.url} target="_blank" rel="noreferrer">Open CPCB e-waste portal ↗</a>}</div></div>}
        <div className="impact-card"><b>{impact ? `Estimated potential: ${impact.min}–${impact.max} kg CO₂e avoided if diverted` : 'CO₂e estimate not configured for this material'}</b><span>{report.impact?.assumption || 'WasteLens only calculates a cited estimate for organic material when a mass class is saved. This is not measured or confirmed diversion.'}</span>{impact && <><small>{report.impact.formula}</small><a href={report.impact.factor_source_url} target="_blank" rel="noreferrer">Factor source · EPA WARM v16 ↗</a><small>{report.impact.factor_scope}</small></>}</div>
      </section>
      <div className="authority-note"><ShieldCheck size={16}/><div><b>{authority ? authority.name : 'Authority directory not configured for this location'}</b><span>{authority ? authority.scope_note : (authorityMatch.scope_note || 'Coordinates did not match the approximate Lucknow pilot extent. No municipal contact is suggested.')}</span><span>{authorityMatch.match_basis || 'Location match unavailable.'}</span>{authorityMatch.boundary_source_url && <a href={authorityMatch.boundary_source_url} target="_blank" rel="noreferrer">Review approximate boundary data ↗</a>}{authority?.channels?.map((channel) => channel.url ? <a key={channel.type} href={channel.url} target="_blank" rel="noreferrer">Open official complaint portal ↗</a> : <span key={channel.value}>{channel.label}: {channel.value}</span>)}{authority?.source_url && <a className="source-link" href={authority.source_url} target="_blank" rel="noreferrer">Official contact source ↗</a>}</div></div>
      {report.is_owner_view ? <><div className="assessment-box"><label className="field-label">WASTE CATEGORIES <span>AI labels need resident review</span></label><input className="text-input" value={categories} onChange={(e) => setCategories(e.target.value)} placeholder="e.g. plastic, food waste"/><label className="field-label severity-label">SEVERITY ASSESSMENT</label><select className="text-input" value={severity} onChange={(e) => setSeverity(e.target.value)}><option value="unassessed">Unassessed</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select><div className="assessment-footer"><span>Severity is a resident estimate; image AI does not infer it.</span><button className="button button-outline" disabled={saving} onClick={saveAssessment}>{saving ? <><span className="button-loader"/> Saving…</> : <>Save assessment <Check size={15}/></>}</button></div></div><section className="complaint-print-area"><label className="field-label complaint-label"><FileText size={14}/> COMPLAINT DRAFT <span>Review and edit before using</span></label><textarea className="complaint-editor" value={draft} onChange={(e) => setDraft(e.target.value)} rows="6"/><div className="draft-footer"><span><ShieldCheck size={14}/> Saved as a draft · not submitted</span><div className="complaint-print-actions"><button type="button" className="button button-outline" onClick={copyDraft}><Clipboard size={14}/> Copy</button><button type="button" className="button button-outline" onClick={printDraft}><Printer size={14}/> Print</button><button type="button" className="button button-green" disabled={saving} onClick={saveDraft}>{saving ? <><span className="button-loader"/> Saving…</> : <>Save changes <Check size={15}/></>}</button></div></div>{draftMessage && <p className="draft-message" role="status">{draftMessage}</p>}</section></> : <p className="private-note"><ShieldCheck size={15}/> This report is read-only. The reporter’s precise location and complaint draft are visible only with their private report token.</p>}
    </div>
  </div>
}

function AssistantPanel({ status, messages, input, busy, context, endRef, onClose, onInput, onSubmit, onClearContext }) {
  const suggestions = [
    'Who can I contact in Lucknow?',
    'Summarize the community board',
    context ? 'Check for possible nearby duplicates' : 'How can I make a useful report?',
  ]
  return <aside className="assistant-panel" aria-label="WasteLens field guide"><div className="assistant-head"><span className="assistant-avatar"><Bot size={18}/></span><div className="assistant-heading"><b>WasteLens field guide</b><span><i className={status.ready ? 'ai-indicator ready' : 'ai-indicator'}/>{status.ready ? 'AI routing configured · access checked on use' : 'Rules-based answers · Bedrock optional'}</span></div><button className="icon-button" onClick={onClose} aria-label="Close field guide"><X size={18}/></button></div>{context && <div className="context-pill"><MapPin size={13}/> Looking at report {context.id.slice(0, 6).toUpperCase()}<button onClick={onClearContext} aria-label="Clear report context"><X size={12}/></button></div>}<div className="assistant-feed">{messages.map((message, index) => <div className={`chat-row ${message.role}`} key={`${index}-${message.role}`}><span className="chat-avatar">{message.role === 'assistant' ? <Sparkles size={13}/> : 'You'}</span><div className="chat-bubble">{message.text}{message.mode && <small className="answer-mode">{message.mode}</small>}</div></div>)}{busy && <div className="chat-row assistant"><span className="chat-avatar"><Sparkles size={13}/></span><div className="chat-bubble typing"><i/><i/><i/></div></div>}<div ref={endRef}/></div><div className="suggestion-row">{suggestions.map((suggestion) => <button key={suggestion} disabled={busy} onClick={(e) => onSubmit(e, suggestion)}>{suggestion}</button>)}</div><form className="assistant-compose" onSubmit={(e) => onSubmit(e)}><textarea aria-label="Ask the WasteLens field guide" placeholder="Ask about reports or next steps…" value={input} onChange={(e) => onInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(e) } }} rows="1"/><button type="submit" disabled={busy || !input.trim()} aria-label="Send question"><Send size={16}/></button></form><p className="ai-privacy"><ShieldCheck size={12}/>{status.ready ? 'Bedrock sees your question only to route intent. Verified answers are assembled locally; report data stays in WasteLens. Avoid names and exact addresses.' : 'This guide runs locally. With AWS configured, Bedrock sees only your question to route intent; answers still come from verified local data.'}</p></aside>
}

export default App
