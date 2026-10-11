import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowRight, ArrowUpRight, Bot, Camera, Check, ChevronDown, CircleHelp, Clipboard, Clock3, Crosshair, FileText, Leaf, MapPin, MessageCircle, Navigation, Printer, Recycle, RefreshCw, ScanLine, Search, Send, ShieldCheck, Sparkles, ThumbsUp, Trash2, UploadCloud, X } from 'lucide-react'
import CommunityMap from './components/CommunityMap.jsx'
import CityScene from './components/CityScene.jsx'
import LogoMark from './components/LogoMark.jsx'
import CommunityThread from './components/CommunityThread.jsx'
import CommunitiesPanel from './components/CommunitiesPanel.jsx'
import AccountPage from './components/AccountPage.jsx'
import CameraCapture from './components/CameraCapture.jsx'
import SocialSidebar from './components/SocialSidebar.jsx'
import { scrollToPageHash } from './page-scroll.js'
import { accountRequest } from './account-api.js'
import AreaPicker from './components/AreaPicker.jsx'
import { getDeviceLocation, lookupNearbyBins } from './location.js'
import { ownerHeaders, rememberOwnerToken } from './owner-tokens.js'
import { createReport, enrichReport, finishReportCreation, ENRICHMENT_STEPS, requireReport, reviewedCategories, retainCreatedReport, savedReportsMissingFromBoard, saveReportDraft, saveReportAssessment, runConfirmedSave, storedReportRecovery } from './report-workflow.js'

const API = import.meta.env.VITE_API_URL || (['localhost', '127.0.0.1'].includes(window.location.hostname) ? `${window.location.protocol}//${window.location.hostname}:8000/api` : '/api')
const API_BASE = API.replace(/\/api\/?$/, '')
const mediaUrl = (path) => path?.startsWith('http') ? path : `${API_BASE}${path || ''}`
const SEVERITY_RANK = { high: 3, medium: 2, low: 1, needs_review: 0, unassessed: 0 }
const WASTE_CATEGORIES = {
  wet_organic: 'Food & garden waste',
  dry_recyclable: 'Dry recyclables',
  e_waste: 'Electronics & batteries',
  hazardous: 'Household hazardous waste',
  mixed: 'Mixed or unsure',
}
const ROUTE_COVERAGE = {
  local_intake_unverified: 'No receiving site in Lucknow is verified',
  named_local_recycler_unverified: 'No named Lucknow recycler is verified',
  local_collection_unverified: 'Local collection is not verified',
  municipal_confirmation_required: 'Ask the municipality to confirm the route',
  local_operator_unverified: 'No local operator is verified',
}
const relativeTime = (value) => {
  const minutes = Math.floor((Date.now() - new Date(value).getTime()) / 60000)
  if (!Number.isFinite(minutes) || minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
let memoryClientToken = ''
const clientToken = () => {
  if (memoryClientToken) return memoryClientToken
  try {
  let token = localStorage.getItem('wastelens-client-token')
  if (!token) { token = crypto.randomUUID(); localStorage.setItem('wastelens-client-token', token) }
  memoryClientToken = token
  return token
  } catch { memoryClientToken = crypto.randomUUID(); return memoryClientToken }
}
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
    if (blob.size <= 3_700_000) return blob
  }
  throw new Error('This photo is too large after compression. Choose a smaller image.')
}

function App() {
  const pageFromHash = () => window.location.hash === '#login' ? 'login' : window.location.hash === '#groups' ? 'groups' : 'feed'
  const [page, setPage] = useState(pageFromHash)
  const [account, setAccount] = useState(null)
  const [accountError, setAccountError] = useState('')
  const socialContentRef = useRef(null)
  useEffect(() => {
    scrollToPageHash(window.location.hash, socialContentRef.current)
  }, [page])
  useEffect(() => {
    const change = () => {
      setPage(pageFromHash())
      scrollToPageHash(window.location.hash, socialContentRef.current)
    }
    window.addEventListener('hashchange', change)
    accountRequest(fetch, API, 'me').then(setAccount).catch(() => setAccountError('Account connection unavailable. Guest reporting is still available.'))
    return () => window.removeEventListener('hashchange', change)
  }, [])
  const [introOpen, setIntroOpen] = useState(true)
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
  const [discussionReportId, setDiscussionReportId] = useState(null)
  const [createdReports, setCreatedReports] = useState({})
  const [pendingUpload, setPendingUpload] = useState(null)
  const [enrichmentByReport, setEnrichmentByReport] = useState({})
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [sortBy, setSortBy] = useState('newest')
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [assistantContext, setAssistantContext] = useState(null)
  const [assistantMessages, setAssistantMessages] = useState([
    { role: 'assistant', text: 'Hey! I’m WasteLens. How’s your neighborhood looking today? Say hello, ask about a waste item, or tell me what you’d like to improve. I can help with reporting, verified Lucknow contacts and safe community action.' },
  ])
  const [assistantInput, setAssistantInput] = useState('')
  const [assistantBusy, setAssistantBusy] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(null)
  const fileRef = useRef(null)
  const assistantEndRef = useRef(null)
  const toastTimer = useRef(null)
  const [photo, setPhoto] = useState(null)
  const [photoPublic, setPhotoPublic] = useState(false)
  const [photoUrl, setPhotoUrl] = useState('')
  const [address, setAddress] = useState('')
  const [latitude, setLatitude] = useState('')
  const [longitude, setLongitude] = useState('')
  const [guidePhoto, setGuidePhoto] = useState(null)
  const [guidePhotoUrl, setGuidePhotoUrl] = useState('')
  const [guideResult, setGuideResult] = useState(null)
  const [guideBusy, setGuideBusy] = useState(false)
  const [guideError, setGuideError] = useState('')
  const [manualCategory, setManualCategory] = useState('wet_organic')
  const [recoveryRoutes, setRecoveryRoutes] = useState({ routes: [] })
  const [nearbyBins, setNearbyBins] = useState(null)
  const [binsBusy, setBinsBusy] = useState(false)
  const [binsError, setBinsError] = useState('')
  const [binsRadius, setBinsRadius] = useState(1500)
  const [showAreaPicker, setShowAreaPicker] = useState(false)
  const [searchPoint, setSearchPoint] = useState(null)
  const [binsPhase, setBinsPhase] = useState('')
  const [deviceFix, setDeviceFix] = useState(null)
  const [reportFix, setReportFix] = useState(null)
  const [locationBusy, setLocationBusy] = useState(false)
  const [locationError, setLocationError] = useState('')

  const refresh = async (quiet = false) => {
    if (!quiet) setRefreshing(true)
    try {
      const [board, authority, ai, impact, security] = await Promise.allSettled([
        fetch(`${API}/reports`),
        fetch(`${API}/authorities?city=Lucknow`),
        fetch(`${API}/ai/status`),
        fetch(`${API}/impact`),
        fetch(`${API}/security/status`),
      ])
      if (board.status !== 'fulfilled' || !board.value.ok) throw new Error('Board unavailable')
      const boardReports = await board.value.json()
      if (!Array.isArray(boardReports)) throw new Error('Board response unreadable')
      boardReports.forEach((report) => requireReport(report))
      setReports(boardReports)
      await Promise.allSettled([
        [authority, setAuthorities], [ai, setAiStatus], [impact, setCommunityImpact], [security, setSecurityStatus],
      ].map(async ([result, setValue]) => {
        if (result.status !== 'fulfilled' || !result.value.ok) return
        const value = await result.value.json()
        if (!value || typeof value !== 'object' || Array.isArray(value)) return
        if (setValue === setAuthorities && !Array.isArray(value.authorities)) return
        setValue(value)
      }))
      setLastUpdated(new Date())
      setError('')
      return true
    } catch {
      setError('The community board could not refresh. Your saved reports are retained; try refreshing the board.')
      return false
    } finally { setRefreshing(false) }
  }

  useEffect(() => {
    refresh()
    const interval = window.setInterval(() => refresh(true), 45000)
    return () => window.clearInterval(interval)
  }, [])
  useEffect(() => {
    const restoreReport = async () => {
      const match = window.location.hash.match(/^#report\/([a-f0-9-]{36})$/i)
      if (!match) return
      try {
        const response = await fetch(`${API}/reports/${match[1]}`, { headers: ownerHeaders(match[1]) })
        if (!response.ok) throw new Error('Saved report could not be loaded. Retry this link when the API is available.')
        const report = requireReport(await response.json(), match[1])
        setSelected(report)
        setEnrichmentByReport((current) => ({ ...current, [report.id]: { ...storedReportRecovery(report), ...(current[report.id] || {}) } }))
      } catch (error) { setError(error.message) }
    }
    void restoreReport()
    window.addEventListener('hashchange', restoreReport)
    return () => window.removeEventListener('hashchange', restoreReport)
  }, [])
  useEffect(() => {
    fetch(`${API}/recovery-routes`).then((response) => response.ok ? response.json() : null)
      .then((directory) => { if (directory) setRecoveryRoutes(directory) }).catch(() => {})
  }, [])
  useEffect(() => {
    if (!photo) { setPhotoUrl(''); return undefined }
    const objectUrl = URL.createObjectURL(photo)
    setPhotoUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [photo])
  useEffect(() => {
    if (!guidePhoto) { setGuidePhotoUrl(''); return undefined }
    const objectUrl = URL.createObjectURL(guidePhoto)
    setGuidePhotoUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [guidePhoto])
  useEffect(() => {
    if (!introOpen) return undefined
    const dismiss = () => {
      setIntroOpen(false)
    }
    const timer = window.setTimeout(dismiss, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 450 : 2600)
    const onKeyDown = (event) => { if (event.key === 'Escape') dismiss() }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.clearTimeout(timer); window.removeEventListener('keydown', onKeyDown) }
  }, [introOpen])
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
  }, [page, reports.length, showForm, selected, assistantOpen, categoryFilter, statusFilter, search])
  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  const flash = (message) => {
    setToast(message)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 3200)
  }
  const useLocation = async () => {
    if (locationBusy) return
    setLocationBusy(true); setLocationError(''); setReportFix(null)
    try {
      const point = await getDeviceLocation()
      setLatitude(point.latitude.toFixed(6)); setLongitude(point.longitude.toFixed(6)); setReportFix(point); setError('')
    } catch (error) { setLocationError(`${error.message} You can enter the coordinates below.`) }
    finally { setLocationBusy(false) }
  }
  const chooseGuidePhoto = (file) => {
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setGuideError('Choose a JPG, PNG, or WebP photo.')
      return
    }
    if (file.size > 8 * 1024 * 1024) {
      setGuideError('Choose a photo smaller than 8 MB.')
      return
    }
    setGuideError(''); setGuideResult(null); setGuidePhoto(file)
  }
  const analyzeCarryWaste = async () => {
    if (!guidePhoto || guideBusy) return
    setGuideBusy(true); setGuideError(''); setGuideResult(null)
    try {
      const safePhoto = await photoToSafeJpeg(guidePhoto)
      const body = new FormData()
      body.append('photo', safePhoto, 'waste-guide.jpg')
      const response = await fetch(`${API}/waste/guide`, { method: 'POST', body })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'The waste guide is temporarily unavailable.')
      setGuideResult(result)
      if (result.classification?.material_category) setManualCategory(result.classification.material_category)
    } catch (e) { setGuideError(e.message || 'Could not analyze this photo. Try again or choose a category below.') }
    finally { setGuideBusy(false) }
  }
  const findNearbyBins = async (manualPoint = null) => {
    if (binsBusy) return
    setBinsError(''); setNearbyBins(null); setDeviceFix(null); setBinsBusy(true)
    setBinsPhase(manualPoint ? 'Searching map data…' : 'Getting device location…')
    try {
      const point = manualPoint || await getDeviceLocation()
      if (!manualPoint) setDeviceFix(point)
      setBinsPhase('Searching map data…')
      const result = await lookupNearbyBins({ api: API, point, radius: binsRadius })
      setNearbyBins({ ...result, origin_kind: manualPoint ? 'chosen area' : 'device location' })
    } catch (error) {
      setBinsError(error.message || 'Could not find nearby bins. Try again later.')
      setShowAreaPicker(true)
    } finally { setBinsBusy(false); setBinsPhase('') }
  }
  const choosePhoto = (file) => {
    if (!file || loading) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return setError('Choose a JPG, PNG, or WebP image.')
    if (file.size > 8 * 1024 * 1024) return setError('Choose an image smaller than 8 MB.')
    setError(''); setPhoto(file)
    if (pendingUpload) setPendingUpload((current) => ({ ...current, uploaded: false }))
  }
  const updateEnrichment = (reportId, step, outcome) => setEnrichmentByReport((current) => ({
    ...current, [reportId]: { ...(current[reportId] || {}), [step]: outcome },
  }))
  const syncOwnerReport = (updated) => {
    setCreatedReports((current) => current[updated.id] ? retainCreatedReport(current, updated) : current)
    setSelected((current) => current?.id === updated.id ? updated : current)
  }
  const retryEnrichment = async (report, step) => {
    await enrichReport({ api: API, report, steps: [step], ownerHeaders,
      onReport: syncOwnerReport,
      onStep: (key, outcome) => updateEnrichment(report.id, key, outcome) })
    await refresh(true)
  }
  const submit = async (event) => {
    event.preventDefault()
    if (loading) return
    setLoading(true); setError('')
    let report
    try {
      report = await createReport({ api: API, cloud: securityStatus?.cloud_storage_configured, photo,
        location: { latitude, longitude, address, photo_public: photoPublic }, pendingUpload, preparePhoto: photoToSafeJpeg,
        rememberOwnerToken, ownerHeaders, onPending: setPendingUpload })
    } catch (e) {
      setError(e.message || 'Something went wrong. Please try again.')
      return
    }
    finally { setLoading(false) }
    // Creation is complete before optional requests begin. Recovery always uses this ID.
    await finishReportCreation({ api: API, report, ownerHeaders,
      onCreated: (saved) => {
        setCreatedReports((current) => retainCreatedReport(current, saved))
        setSelected(saved); window.history.replaceState(null, '', `#report/${saved.id}`); setShowForm(false); setPhoto(null); setPhotoPublic(false)
        if (fileRef.current) fileRef.current.value = ''
        setAddress(''); setLatitude(''); setLongitude('')
        flash('Report saved. Optional analysis is running.')
      },
      onReport: syncOwnerReport,
      onStep: (step, outcome) => updateEnrichment(report.id, step, outcome), refreshBoard: () => refresh(true) })
  }
  const saveDraft = async (report, draft) => {
    const updated = await saveReportDraft({ api: API, report, draft, ownerHeaders })
    syncOwnerReport(updated); flash('Complaint draft saved; nothing sent.'); void refresh(true)
    return updated
  }
  const saveAssessment = async (report, categories, severity) => {
    const updated = await saveReportAssessment({ api: API, report, categories, severity, ownerHeaders })
    syncOwnerReport(updated); flash('Community assessment updated.'); void refresh(true)
    return updated
  }
  const syncSubmittedReport = async (updated) => {
    if (updated) syncOwnerReport(updated)
    await refresh(true)
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
  const askAboutReport = (report, intent = 'nearby') => {
    setAssistantContext(report); setSelected(null); setAssistantOpen(true)
    if (intent === 'solutions') setAssistantInput('Suggest community cleanup solutions for this report')
    setAssistantMessages((messages) => [...messages, { role: 'assistant', text: `I’m looking at report ${report.id.slice(0, 6).toUpperCase()}. I can suggest community next steps or check nearby reports. Exact coordinates and discussion messages are not sent to the AI model.` }])
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
        mode: result.ai_used ? 'AWS Bedrock · grounded help plan' : result.mode === 'local_conversation' ? 'WasteLens · quick reply' : 'Local pilot guidance',
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
  const manualRecoveryRoute = recoveryRoutes.routes?.find((route) => route.category === manualCategory)
  const unlistedCreatedReports = savedReportsMissingFromBoard(createdReports, reports)

  return <div className="page-shell" id="top" onClick={(event) => {
    const hash = event.target.closest('a')?.getAttribute('href')
    if (hash === window.location.hash && ['#top', '#community', '#everyday', '#how', '#groups', '#login'].includes(hash)) {
      event.preventDefault()
      scrollToPageHash(hash, socialContentRef.current)
    }
  }}>
    {introOpen && <div className="splash-screen" aria-label="WasteLens welcome"><div className="splash-art"><span className="splash-leaf splash-leaf-a"><Leaf size={22}/></span><span className="splash-leaf splash-leaf-b"><Leaf size={16}/></span><span className="splash-logo"><LogoMark/></span><span className="splash-ring"/></div><div className="splash-wordmark">waste<span>lens</span></div><div className="splash-rule"/><p>Small acts. Cleaner streets.</p><button autoFocus className="splash-skip" onClick={() => setIntroOpen(false)}>Skip intro <ArrowRight size={13}/></button></div>}
    <header className="topbar"><a className="brand" href="#top"><span className="brand-mark"><LogoMark/></span><span>waste<span className="brand-light">lens</span></span></a><nav><a href="#community">Feed</a><a href="#groups">Communities</a><a href="#everyday">Guide</a><a href="#how">How it works</a><button className="nav-ai" onClick={() => setAssistantOpen(true)}><Sparkles size={14}/> Field guide</button></nav>{officialPortalUrl ? <a className="button button-dark top-cta" href={officialPortalUrl} target="_blank" rel="noreferrer"><ArrowUpRight size={15}/> Official LNN portal</a> : <span className="top-portal-unavailable">Municipal portal not configured</span>}<a className="top-account" href="#login"><span className="top-avatar">{account ? account.name.slice(0,1).toUpperCase() : <Leaf size={15}/>}</span>{account ? account.name : 'Log in'}</a></header>
    {error && <div className="notice" role="alert"><CircleHelp size={16}/>{error}<button onClick={() => setError('')} aria-label="Dismiss"><X size={15}/></button></div>}
    {toast && <div className="toast" role="status"><span><Check size={15}/></span>{toast}<button onClick={() => setToast('')} aria-label="Dismiss"><X size={14}/></button></div>}
    {unlistedCreatedReports.map((report) => <div className="saved-report-notice" key={report.id} role="status"><Check size={15}/><span><b>Report saved · {report.id.slice(0, 8).toUpperCase()}</b> Your report is available while the board catches up.</span><button className="button button-outline" onClick={() => setSelected(report)}>Open saved report <ArrowUpRight size={14}/></button></div>)}
    <div className="social-app-layout" data-modal-open={showForm || Boolean(selected) ? 'true' : undefined}><SocialSidebar page={page} user={account} onAsk={() => setAssistantOpen(true)}/><main className="social-content" ref={socialContentRef} tabIndex={0} aria-label="WasteLens content">
    {accountError && <p className="account-connect-note" role="status">{accountError}</p>}
    {page === 'login' ? <AccountPage api={API} user={account} onAccount={(user) => { setAccount(user); setAccountError('') }}/> : page === 'groups' ? <section className="community-hub"><div className="hub-cover"><span className="eyebrow">CLEANER STREETS. STRONGER CONNECTIONS.</span><h1>Find your people.<br/><em>Change your corner.</em></h1><p>A neighborhood group, a student club, or a few friends who care. Make a home for your shared goal.</p><span className="hub-flower" aria-hidden="true">✳</span></div><CommunitiesPanel registration api={API} getClientToken={clientToken} user={account}/></section> : <>
      <section className="hero">
        <div className="hero-copy"><div className="eyebrow hero-eyebrow"><span className="pulse-dot"/> LUCKNOW PILOT · YOUR CITY, YOUR MOVE</div><h1>Your street.<br/><span>Your people.</span></h1><p className="hero-deck">A place for the neighbors who notice. Share a sighting, talk about solutions, and make a cleaner tomorrow together.</p><div className="hero-actions"><a className="button button-green" href="#groups">Find your community <ArrowRight size={17}/></a><a className="text-link" href="#community">See the neighborhood <ArrowDown size={15}/></a></div><div className="privacy-note"><span className="hero-mini-icon"><Leaf size={14}/></span> One photo. One neighborhood. A little more care.</div></div>
        <CityScene/>
      </section>

      <section className="community-section" id="community"><div className="section-heading reveal"><div><div className="eyebrow muted">THE NEIGHBORHOOD NOTICEBOARD</div><h2>The neighborhood <br/><span>starts here.</span></h2></div><div className="heading-right"><span className="live-indicator"><span/> COMMUNITY REPORTS</span></div></div>
        <div className="feed-composer"><span className="composer-avatar">{account ? account.name.slice(0,1).toUpperCase() : <Leaf size={24}/>}</span><div><b>{account ? `What’s happening, ${account.name}?` : 'What’s happening on your street?'}</b><p>A photo, a place, a chance to make it better.</p></div><button className="button button-green" onClick={() => setShowForm(true)}><Camera size={17}/> Share a waste sighting</button></div>
        <div className="board-toolbar reveal"><div className="board-title"><span className="board-dot"/> RECENT SIGHTINGS <span className="count-pill">{filteredReports.length}<span className="count-total"> / {reports.length}</span></span></div><div className="board-controls"><label className="search-field"><Search size={15}/><input aria-label="Search community reports" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search reports"/>{search && <button aria-label="Clear search" onClick={() => setSearch('')}><X size={13}/></button>}</label><label className="status-filter"><span className="sr-only">Filter by status</span><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><option value="all">All statuses</option><option value="community_reported">New</option><option value="reviewed">Reviewed</option><option value="cleanup_confirmed">Cleanup confirmed</option></select><ChevronDown size={13}/></label><label className="sort-select"><span className="sr-only">Sort reports</span><select value={sortBy} onChange={(e) => setSortBy(e.target.value)}><option value="newest">Most recent</option><option value="oldest">Oldest first</option><option value="supported">Most supported</option><option value="severity">Highest severity</option></select><ChevronDown size={13}/></label><button className="refresh-button" onClick={() => refresh()} aria-label="Refresh reports" title={lastUpdated ? `Last updated ${lastUpdated.toLocaleTimeString()}` : 'Refresh reports'}><RefreshCw size={15} className={refreshing ? 'spin' : ''}/></button></div></div>
        {categories.length > 0 && <div className="category-filters reveal" aria-label="Filter reports by waste category"><button className={categoryFilter === 'all' ? 'filter-chip active' : 'filter-chip'} onClick={() => setCategoryFilter('all')}>All waste <span>{reports.length}</span></button>{categories.map((category) => <button key={category} className={categoryFilter === category ? 'filter-chip active' : 'filter-chip'} onClick={() => setCategoryFilter(categoryFilter === category ? 'all' : category)}>{category}</button>)}</div>}
        {reports.length === 0 ? <div className="empty-state reveal"><div className="empty-art"><div className="empty-ring ring-a"/><div className="empty-ring ring-b"/><span><Camera size={24}/></span><i>✳</i></div><div className="empty-copy"><span className="empty-kicker">A BETTER BLOCK STARTS HERE</span><h3>{error ? 'Your board is waiting to connect.' : 'Nothing on the board. Yet.'}</h3><p>Notice an overflowing bin, a vacant lot, or a forgotten corner? Choose “Share a waste sighting” above; neighbors can comment and support it here.</p></div><div className="empty-index">01 <span>—</span> 01</div></div> : filteredReports.length ? <div className="report-grid">{filteredReports.map((report, index) => <ReportCard key={report.id} report={report} index={index} onOpen={() => { setDiscussionReportId(null); void openReport(report) }} onComment={() => { setDiscussionReportId(report.id); void openReport(report) }} onSupport={() => support(report)} onAsk={() => askAboutReport(report)}/>)}</div> : <div className="no-results reveal"><Search size={20}/><div><b>No reports match those filters.</b><span>Try another category or clear your search.</span></div><button className="button button-outline" onClick={() => { setSearch(''); setCategoryFilter('all'); setStatusFilter('all') }}>Clear filters</button></div>}
        <div className="community-city-layout"><section className="community-map-panel reveal" aria-label="Map of approximate community reports"><div className="community-map-title"><div><div className="eyebrow muted">LUCKNOW PILOT · APPROXIMATE REPORT LOCATIONS</div><h3>See what’s happening nearby</h3></div><span>{filteredReports.length} visible {filteredReports.length === 1 ? 'report' : 'reports'}</span></div><CommunityMap reports={filteredReports} onOpen={openReport}/><p className="map-privacy-note">Map pins use rounded locations. Photos appear when their reporter chooses to share; exact addresses stay private.</p></section><CommunitiesPanel compact api={API} getClientToken={clientToken} user={account}/></div>
        <div className="board-foot"><span><span className="foot-dot"/> {reports.length ? `Showing ${filteredReports.length} of ${reports.length} community reports` : 'Waiting for the first neighborhood report'} · {lastUpdated ? `synced ${relativeTime(lastUpdated.toISOString())}` : 'syncing'}</span><span>ESTIMATES ARE LABELLED &nbsp;·&nbsp; COMMUNITY STATUS ONLY</span></div>
      </section>

      <section className="everyday-section" id="everyday"><div className="everyday-heading reveal"><div><span className="eyebrow muted">GOOD HABITS. LESS GUESSWORK.</span><h2>Small choices.<br/><span>Better places.</span></h2></div><p>Get a practical next step for something you’re carrying, or find a mapped public bin around you.</p></div><div className="everyday-grid">
        <article className="everyday-card guide-card reveal"><div className="tool-card-top"><span className="tool-icon"><Recycle size={18}/></span><span className="tool-kicker">PERSONAL WASTE GUIDE</span><span className="tool-index">01</span></div><h3>What am I carrying?</h3><p className="tool-intro">Show us an item or small bag of waste. Get a visual category suggestion and locally sourced handling guidance.</p><label className={`guide-upload ${guidePhoto ? 'has-photo' : ''}`}><span className="guide-preview">{guidePhotoUrl ? <img src={guidePhotoUrl} alt="Selected waste photo preview"/> : <Camera size={20}/>}</span><span className="guide-upload-copy"><b>{guidePhoto ? guidePhoto.name : 'Add a photo to get started'}</b><small>{guidePhoto ? 'Choose a different photo' : 'JPG, PNG or WebP · max 8 MB'}</small></span><span className="guide-upload-action">{guidePhoto ? 'Change' : 'Choose photo'}</span><input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => chooseGuidePhoto(event.target.files[0])}/></label><CameraCapture onCapture={chooseGuidePhoto} disabled={guideBusy}/><button className="button button-green guide-action" disabled={!guidePhoto || guideBusy} onClick={analyzeCarryWaste}>{guideBusy ? <><span className="button-loader"/> Looking closely…</> : <><Sparkles size={15}/> Analyze this photo <ArrowRight size={15}/></>}</button>{guideError && <p className="tool-error" role="alert">{guideError}</p>}
          {guideResult?.analysis_available && guideResult.classification && <div className="guide-result" aria-live="polite"><div className="result-label"><Sparkles size={13}/> {guideResult.source === 'aws_rekognition' ? 'AWS REKOGNITION SUGGESTION · PLEASE REVIEW' : 'AI SUGGESTION · PLEASE REVIEW'}</div><b className="guide-category">{guideResult.classification.material_label}</b><p>{guideResult.classification.visual_note}</p>{guideResult.classification.material_clues?.length > 0 && <p>Visible material clues: {guideResult.classification.material_clues.join(", ")}</p>}{guideResult.classification.uncertainty && <p>{guideResult.classification.uncertainty}</p>}<div className="guide-advice"><b>Suggested next step</b><span>{guideResult.classification.segregation_advice}</span>{guideResult.mass_range_kg && <small>Rough visual estimate: {guideResult.mass_range_kg.min}–{guideResult.mass_range_kg.max} kg · not weighed</small>}</div></div>}
          {guideResult && !guideResult.analysis_available && <p className="tool-fallback" role="status">{guideResult.note || 'Photo analysis isn’t available right now.'} You can still choose a category below for source-backed guidance.</p>}
          <label className="category-picker"><span>Review or choose the category yourself</span><select value={manualCategory} onChange={(event) => setManualCategory(event.target.value)}>{Object.entries(WASTE_CATEGORIES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          {manualRecoveryRoute && <div className="route-advice"><div><b>{manualRecoveryRoute.title}</b><span>{manualRecoveryRoute.advice}</span><small>{ROUTE_COVERAGE[manualRecoveryRoute.availability] || 'Local availability is not verified'}</small>{(manualRecoveryRoute.source_url || manualRecoveryRoute.url) && <a href={manualRecoveryRoute.source_url || manualRecoveryRoute.url} target="_blank" rel="noreferrer">Check the source ↗</a>}</div></div>}
          <p className="tool-privacy"><ShieldCheck size={13}/> Your photo is sent for analysis only when you tap the button. WasteLens does not save it; Bedrock photo analysis is optional.</p>
        </article>

        <article className="everyday-card bins-card reveal"><div className="tool-card-top"><span className="tool-icon"><Trash2 size={18}/></span><span className="tool-kicker">LUCKNOW PILOT · MAP DATA</span><span className="tool-index">02</span></div><h3>Find a nearby bin</h3><p className="tool-intro">Search community-mapped public litter bins and recycling containers around your current location.</p><div className="radius-picker"><label htmlFor="bin-radius">Search within</label><select id="bin-radius" value={binsRadius} disabled={binsBusy} onChange={(event) => { setBinsRadius(Number(event.target.value)); setNearbyBins(null) }}><option value={500}>500 metres</option><option value={1000}>1 kilometre</option><option value={1500}>1.5 kilometres</option><option value={3000}>3 kilometres</option></select></div><button className="button button-dark guide-action" onClick={() => findNearbyBins()} disabled={binsBusy}>{binsBusy ? <><span className="button-loader"/> {binsPhase}</> : <><Crosshair size={15}/> Use my location <ArrowRight size={15}/></>}</button>{binsError && <p className="tool-error" role="alert">{binsError}</p>}<button type="button" className="choose-area-button" disabled={binsBusy} aria-expanded={showAreaPicker} onClick={() => setShowAreaPicker((open) => !open)}><MapPin size={14}/>{showAreaPicker ? 'Hide area picker' : 'Choose an area on the map instead'}</button>{deviceFix && <p className="draft-message" role="status">Device returned {deviceFix.latitude.toFixed(6)}, {deviceFix.longitude.toFixed(6)} · accuracy {deviceFix.accuracy == null ? 'not provided' : `±${Math.round(deviceFix.accuracy)} m`}. {deviceFix.accuracy > 500 && 'Approximate fix: choose or correct the search point manually.'}</p>}{showAreaPicker && <AreaPicker point={searchPoint} onChange={(point) => { setSearchPoint(point); setNearbyBins(null) }} busy={binsBusy} onSearch={() => findNearbyBins(searchPoint)}/>}
          {!nearbyBins && !binsBusy && !binsError && <div className="bin-empty-state"><span className="bin-empty-mark"><MapPin size={19}/></span><div><b>Your corner, in a {binsRadius >= 1000 ? `${binsRadius / 1000} km` : `${binsRadius} m`} circle</b><span>One lookup after you tap. No background tracking.</span></div><span className="bin-empty-spark">✳</span></div>}
          {nearbyBins && <div className="bin-results" aria-live="polite"><div className="bin-results-head"><b>{nearbyBins.results.length ? `${nearbyBins.results.length} mapped ${nearbyBins.results.length === 1 ? 'place' : 'places'}` : 'No mapped places found'}</b><span>around your {nearbyBins.origin_kind} · within {nearbyBins.radius_meters >= 1000 ? `${nearbyBins.radius_meters / 1000} km` : `${nearbyBins.radius_meters} m`}</span></div>{nearbyBins.results.length ? <ul>{nearbyBins.results.map((bin) => { const directions = `https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot&route=${nearbyBins.origin.latitude},${nearbyBins.origin.longitude};${bin.latitude},${bin.longitude}`; return <li key={bin.id}><span className="bin-pin"><MapPin size={14}/></span><div className="bin-copy"><b>{bin.name || bin.kind}</b><span>{bin.kind} · {bin.distance_meters < 1000 ? `${bin.distance_meters} m` : `${(bin.distance_meters / 1000).toFixed(1)} km`}</span><small>{bin.mapped_materials === 'Not specified on the map' ? 'Accepted waste not tagged' : `Mapped for: ${bin.mapped_materials}`} · access {bin.access.toLowerCase()}</small><div className="bin-links"><a href={bin.map_url} target="_blank" rel="noreferrer">Map details</a><a href={directions} target="_blank" rel="noreferrer"><Navigation size={12}/> Walking directions</a></div></div></li> })}</ul> : <p className="no-bins-note">That doesn’t mean there are no bins—only that none are mapped in this search area.</p>}</div>}
          <p className="tool-privacy"><ShieldCheck size={13}/> A one-time location query goes to OpenStreetMap’s Overpass service. Results may be incomplete or outdated; check access and accepted waste on site. <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">Map data © OpenStreetMap</a></p>
        </article>
      </div></section>

      <section className="impact-strip reveal"><div><span className="metric">{reports.length.toString().padStart(2,'0')}</span><span className="metric-label">community reports</span></div><i/><div><span className="metric">{totalSupports.toString().padStart(2,'0')}</span><span className="metric-label">neighbors supporting</span></div><i/><div className="impact-message"><span className="impact-icon"><Leaf size={15}/></span><span>{communityImpact?.reports_with_estimate ? `${communityImpact.co2e_avoided_if_diverted_kg.min}–${communityImpact.co2e_avoided_if_diverted_kg.max} kg CO₂e` : 'No impact estimate yet'}<br/><b>estimated potential if diverted</b></span></div><span className="strip-star">✳</span></section>

      <section className="bottom-band reveal" id="how"><div className="bottom-spark">✳</div><div><span className="eyebrow">FROM SIGHTING TO SOLUTION</span><h2>Don’t scroll past it.<br/><em>Show up for it.</em></h2></div><div className="steps"><div><span>01</span><b>Spot a waste site</b><small>Snap a photo and pin the location.</small></div><div><span>02</span><b>Get a clear next step</b><small>Review an editable complaint draft.</small></div><div><span>03</span><b>Bring others along</b><small>Discuss the report and plan a next step together.</small></div></div></section>
      <div className="privacy-footer"><ShieldCheck size={13}/> Shared photos bring neighbors together. Exact locations and complaint drafts stay private.</div>
    </>}
    <footer><a className="brand" href="#top"><span className="brand-mark"><LogoMark/></span><span>waste<span className="brand-light">lens</span></span></a><span className="footer-quote">A better tomorrow starts on your street.</span><span>COMMUNITY POWERED · ESTIMATE LABELLED</span></footer>
    </main></div>

    {showForm && <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setShowForm(false)}><form className="modal report-modal" role="dialog" aria-modal="true" aria-labelledby="report-form-title" onSubmit={submit}><div className="modal-head"><div><div className="eyebrow muted">ADD TO THE COMMUNITY BOARD</div><h2 id="report-form-title">Report a waste site</h2></div><button type="button" className="icon-button" onClick={() => setShowForm(false)} aria-label="Close report form"><X size={19}/></button></div><label className={`upload-box ${photo ? 'has-photo' : ''}`} onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('dragging') }} onDragLeave={(e) => e.currentTarget.classList.remove('dragging')} onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove('dragging'); choosePhoto(e.dataTransfer.files[0]) }}>{photo ? <><img src={photoUrl} alt="Selected report preview"/><span className="upload-caption"><Check size={16}/>{photo.name}<small>Click or drop to choose another photo</small></span></> : <><UploadCloud size={23}/><b>Drop a photo or browse files</b><small>JPG, PNG or WebP · max 8 MB</small></>}<input ref={fileRef} type="file" disabled={loading} accept="image/jpeg,image/png,image/webp" required={!photo} onChange={(e) => choosePhoto(e.target.files[0])}/></label><CameraCapture onCapture={choosePhoto} disabled={loading}/><label className="field-label">LOCATION · LUCKNOW PILOT <button type="button" className="locate-link" disabled={loading || locationBusy || Boolean(pendingUpload)} onClick={useLocation}><Crosshair size={13}/> {locationBusy ? 'Locating…' : 'Use my location'}</button></label><input required disabled={loading || Boolean(pendingUpload)} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street, landmark or neighborhood in Lucknow" className="text-input"/><div className="coordinate-row"><input required disabled={loading || Boolean(pendingUpload)} type="number" step="any" value={latitude} onChange={(e) => { setLatitude(e.target.value); setReportFix(null) }} aria-label="Report latitude" placeholder="Latitude" className="text-input"/><input required disabled={loading || Boolean(pendingUpload)} type="number" step="any" value={longitude} onChange={(e) => { setLongitude(e.target.value); setReportFix(null) }} aria-label="Report longitude" placeholder="Longitude" className="text-input"/></div>{reportFix && <p className="draft-message" role="status">Device returned {reportFix.latitude.toFixed(6)}, {reportFix.longitude.toFixed(6)} · accuracy {reportFix.accuracy == null ? 'not provided' : `±${Math.round(reportFix.accuracy)} m`}. Check and correct the waste site location before filing.</p>}{locationError && <p className="tool-error" role="alert">{locationError}</p>}{error && <p className="tool-error" role="alert">{error}</p>}<label className="jurisdiction-check photo-sharing-choice"><input type="checkbox" checked={photoPublic} disabled={loading || Boolean(pendingUpload)} onChange={(event) => setPhotoPublic(event.target.checked)}/><span><b>Share this photo on the community board</b><br/>Anyone can view or download it. Check for faces, number plates and private details before sharing. Exact coordinates and complaint drafts stay private.</span></label><label className="jurisdiction-check"><input type="checkbox" required/><span>I confirm this site is within Lucknow Nagar Nigam’s jurisdiction.</span></label>{pendingUpload && <p className="draft-message" role="status">Submission reference {pendingUpload.reportId.slice(0, 8).toUpperCase()}. Confirmation is pending. Retry this submission safely; do not start another.</p>}<div className="form-foot"><span><ShieldCheck size={14}/> Nothing is sent to an authority</span><button className="button button-green" disabled={loading || !photo}>{loading ? <><span className="button-loader"/> {pendingUpload ? 'Confirming submission…' : 'Creating report…'}</> : <>{pendingUpload ? 'Retry this submission safely' : 'Create community report'} <ArrowRight size={15}/></>}</button></div></form></div>}
    {selected && <ReportDetail report={selected} focusComments={discussionReportId === selected.id} onClose={() => { setSelected(null); if (window.location.hash.startsWith('#report/')) window.location.hash = 'community' }} onSave={saveDraft} onAssess={saveAssessment} onSupport={support} onAsk={() => askAboutReport(selected)} onPlan={() => askAboutReport(selected, 'solutions')} onSubmitted={syncSubmittedReport} enrichment={enrichmentByReport[selected.id] || {}} onRetryEnrichment={retryEnrichment}/>}
    {assistantOpen && <AssistantPanel status={aiStatus} messages={assistantMessages} input={assistantInput} busy={assistantBusy} context={assistantContext} endRef={assistantEndRef} onClose={() => setAssistantOpen(false)} onInput={setAssistantInput} onSubmit={askAssistant} onClearContext={() => setAssistantContext(null)}/>}
    {!assistantOpen && <button className="assistant-fab" onClick={() => setAssistantOpen(true)} aria-label="Open WasteLens field guide"><span className="fab-orbit"/><Sparkles size={17}/><span>Ask WasteLens</span><i className={aiStatus.ready ? 'ai-indicator ready' : 'ai-indicator'}/></button>}
  </div>
}

function ReportCard({ report, index, onOpen, onComment, onSupport, onAsk }) {
  const colors = ['#e9e6d7','#d9e3cf','#e4d9cd','#d9e1dc']
  const impact = report.impact?.co2e_avoided_if_diverted_kg
  return <article className="report-card reveal" style={{ '--card-delay': `${Math.min(index, 5) * 70}ms` }}><button className="card-image" onClick={onOpen} style={{ backgroundColor: colors[index % colors.length] }} aria-label={`Open report at ${report.address || 'reported location'}`}>{report.image_path ? <img src={mediaUrl(report.image_path)} alt="Reported unmanaged waste"/> : <span className="private-photo-placeholder"><ShieldCheck size={17}/> Photo not shared publicly</span>}<span className="card-id">WL · {report.id.slice(0, 5).toUpperCase()}</span><span className="open-card"><ArrowUpRight size={17}/></span></button><div className="card-info"><div className="feed-author"><span>WL</span><div><b>Neighborhood sighting</b><small>Lucknow community report</small></div><span className="feed-post-mark">✳</span></div><button className="card-location location-link" onClick={onOpen}><MapPin size={13}/><span>{report.address || `${report.latitude.toFixed(2)}, ${report.longitude.toFixed(2)} · approximate`}</span></button><h3>{report.categories.length ? report.categories.join(', ') : 'Unmanaged waste'}</h3><div className="card-tags"><span className={`severity severity-${report.severity}`}>{report.severity.replace('_', ' ')}</span><span className="status-tag"><Clock3 size={12}/>{report.status.replaceAll('_', ' ')}</span><span className="report-age">{relativeTime(report.created_at)}</span></div><div className="card-bottom"><span className="estimate">{impact ? `Est. ${impact.min}–${impact.max} kg CO₂e if diverted` : 'Impact estimate not configured'}</span><div className="card-actions"><button className="comment-card" onClick={onComment} aria-label="Comment on this report"><MessageCircle size={14}/> Comment</button><button className="ask-card" onClick={onAsk} aria-label="Ask the field guide about this report" title="Check for nearby duplicates"><Sparkles size={13}/></button><button className="support-button" onClick={onSupport}><ThumbsUp size={14}/>{report.supports}</button></div></div></div></article>
}

function ReportDetail({ report: initial, focusComments = false, enrichment = {}, onRetryEnrichment, onClose, onSave, onAssess, onSupport, onAsk, onPlan, onSubmitted }) {
  const [report, setReport] = useState(initial)
  const [draft, setDraft] = useState(initial.complaint || '')
  const [isSaving, setSaving] = useState(false)
  const saving = isSaving || Object.values(enrichment).some((step) => step.status === 'running')
  const [categories, setCategories] = useState((initial.categories || []).join(', '))
  const [severity, setSeverity] = useState(initial.severity || 'unassessed')
  const [materialCategory, setMaterialCategory] = useState(initial.material_category || 'mixed')
  const [massClass, setMassClass] = useState(initial.mass_class || 'small')
  const [classificationNote, setClassificationNote] = useState(initial.analysis_note || '')
  const [draftMessage, setDraftMessage] = useState('')
  const [draftFailed, setDraftFailed] = useState(false)
  const [assessmentMessage, setAssessmentMessage] = useState('')
  const [assessmentFailed, setAssessmentFailed] = useState(false)
  const [authorityMatch, setAuthorityMatch] = useState({ configured: false, authorities: [] })
  const [emailService, setEmailService] = useState(null)
  const [confirmJurisdiction, setConfirmJurisdiction] = useState(false)
  const [confirmSend, setConfirmSend] = useState(false)
  const [sendMessage, setSendMessage] = useState('')
  const [detailPhotoUrl, setDetailPhotoUrl] = useState('')
  const [sharingError, setSharingError] = useState('')
  const changePhotoSharing = async () => {
    setSaving(true); setSharingError('')
    try {
      const response = await fetch(`${API}/reports/${report.id}/photo-sharing`, {
        method: 'PATCH', headers: ownerHeaders(report.id, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ photo_public: !report.photo_public }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail || 'Photo sharing could not be updated.')
      const updated = requireReport(result.report, report.id)
      if (updated.photo_public !== !report.photo_public) throw new Error('The sharing change was not confirmed. Refresh this report before retrying.')
      setReport(updated); await onSubmitted(updated)
    } catch (error) { setSharingError(error.message || 'Photo sharing could not be updated. Try again.') }
    finally { setSaving(false) }
  }
  const previousInitial = useRef(initial)
  useEffect(() => {
    const previous = previousInitial.current
    const changedReport = previous.id !== initial.id
    setReport(initial)
    // Optional enrichment can update the report while the resident is typing.
    setDraft((value) => changedReport || value === (previous.complaint || '') ? initial.complaint || '' : value)
    setCategories((value) => changedReport || value === (previous.categories || []).join(', ') ? (initial.categories || []).join(', ') : value)
    setSeverity((value) => changedReport || value === (previous.severity || 'unassessed') ? initial.severity || 'unassessed' : value)
    setMaterialCategory((value) => changedReport || value === (previous.material_category || 'mixed') ? initial.material_category || 'mixed' : value)
    setMassClass((value) => changedReport || value === (previous.mass_class || 'small') ? initial.mass_class || 'small' : value)
    setClassificationNote(initial.analysis_note || '')
    setConfirmJurisdiction(false); setConfirmSend(false); setSendMessage('')
    if (changedReport) { setDraftMessage(''); setAssessmentMessage(''); setDraftFailed(false); setAssessmentFailed(false) }
    previousInitial.current = initial
  }, [initial])
  useEffect(() => {
    let active = true
    let objectUrl = ''
    if (!initial.image_path) { setDetailPhotoUrl(''); return undefined }
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
  }, [initial.id, initial.image_path, initial.is_owner_view, initial.photo_public])
  useEffect(() => {
    let active = true
    fetch(`${API}/authorities?latitude=${initial.latitude}&longitude=${initial.longitude}`)
      .then((response) => response.ok ? response.json() : null)
      .then((result) => { if (active && result) setAuthorityMatch(result) })
      .catch(() => { if (active) setAuthorityMatch({ configured: false, authorities: [] }) })
    return () => { active = false }
  }, [initial.id, initial.latitude, initial.longitude])
  useEffect(() => {
    let active = true
    if (!initial.is_owner_view) { setEmailService(null); return undefined }
    fetch(`${API}/submission/status`)
      .then((response) => response.ok ? response.json() : null)
      .then((result) => { if (active && result) setEmailService(result) })
      .catch(() => { if (active) setEmailService({ available: false, recipient: '' }) })
    return () => { active = false }
  }, [initial.id, initial.is_owner_view])
  const authority = authorityMatch.configured && authorityMatch.authorities.length ? authorityMatch.authorities[0] : null
  const submissionEligible = Boolean(emailService?.available && authority)
  const saveAssessment = async () => {
    if (saving) return
    const reviewed = reviewedCategories(categories)
    await runConfirmedSave({ setSaving, save: () => onAssess(report, reviewed, severity),
      clearFeedback: () => { setAssessmentMessage(''); setAssessmentFailed(false) },
      onSaved: (updated) => { setReport(updated); setCategories(updated.categories.join(', ')); setSeverity(updated.severity); setAssessmentMessage('Assessment saved.') },
      onError: (message) => { setAssessmentMessage(message); setAssessmentFailed(true) } })
  }
  const saveDraft = async () => {
    if (saving) return
    await runConfirmedSave({ setSaving, save: () => onSave(report, draft),
      clearFeedback: () => { setDraftMessage(''); setDraftFailed(false) },
      onSaved: (updated) => { setReport(updated); setDraft(updated.complaint); setDraftMessage('Complaint draft saved; nothing sent.') },
      onError: (message) => { setDraftMessage(message); setDraftFailed(true) } })
  }
  const submitComplaint = async () => {
    setSaving(true)
    setSendMessage('')
    try {
      const response = await fetch(`${API}/reports/${report.id}/submit`, {
        method: 'POST',
        headers: ownerHeaders(report.id, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ draft, confirmed: true, jurisdiction_confirmed: true }),
      })
      const result = await response.json()
      if (!response.ok && response.status !== 202) {
        setSendMessage(result.detail || 'Email submission failed.')
        setConfirmJurisdiction(false)
        setConfirmSend(false)
        const detail = await fetch(`${API}/reports/${report.id}`, { headers: ownerHeaders(report.id) })
        if (detail.ok) { const latest = await detail.json(); setReport(latest); await onSubmitted(latest) }
        return
      }
      let updated = result.report
      if (!updated) {
        const detail = await fetch(`${API}/reports/${report.id}`, { headers: ownerHeaders(report.id) })
        if (detail.ok) updated = await detail.json()
      }
      if (updated) { setReport(updated); await onSubmitted(updated) }
      setSendMessage(result.detail || result.delivery_note || 'Email accepted by SES for delivery. LNN receipt or ticket creation is not guaranteed.')
      setConfirmJurisdiction(false)
      setConfirmSend(false)
    } catch {
      setSendMessage('Could not confirm the email result. Refresh the report before taking another action.')
      setConfirmJurisdiction(false)
      setConfirmSend(false)
      const detail = await fetch(`${API}/reports/${report.id}`, { headers: ownerHeaders(report.id) }).catch(() => null)
      if (detail?.ok) { const latest = await detail.json(); setReport(latest); await onSubmitted(latest) }
    } finally { setSaving(false) }
  }
  const copyDraft = async () => {
    setDraftFailed(false)
    try { await navigator.clipboard.writeText(draft); setDraftMessage('Complaint text copied.') }
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
  const submissionState = report.submission_state || 'not_sent'
  const submissionLocked = !['not_sent', 'delivery_failed'].includes(submissionState)
  const assessmentDirty = reviewedCategories(categories).join(',') !== (report.categories || []).join(',') || severity !== (report.severity || 'unassessed')
  const categoryLabels = { wet_organic: 'Wet / organic', dry_recyclable: 'Dry recyclable', e_waste: 'E-waste', hazardous: 'Hazardous household waste', mixed: 'Mixed or uncertain' }
  return <div className="modal-backdrop detail-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <div className="detail-modal">
      <div className="detail-top"><div className="eyebrow muted">COMMUNITY REPORT · {report.id.slice(0, 8).toUpperCase()}</div><button className="icon-button" onClick={onClose} aria-label="Close report details"><X size={19}/></button></div>
      <div className="detail-grid">{detailPhotoUrl ? <img className="detail-photo" src={detailPhotoUrl} alt="Reported waste site"/> : <div className="detail-photo private-photo-placeholder"><ShieldCheck size={18}/>{report.image_path ? 'Photo unavailable; try reopening this report.' : 'Photo not shared publicly'}</div>}<div className="detail-content"><div className="card-location"><MapPin size={14}/>{report.address || `${report.latitude}, ${report.longitude} · approximate`}</div><h2>{report.categories.length ? report.categories.join(', ') : 'Unmanaged waste'}</h2><div className="card-tags"><span className={`severity severity-${report.severity}`}>{report.severity.replace('_', ' ')}</span><span className="status-tag">{report.status.replaceAll('_', ' ')}</span></div><p className="analysis-note"><Sparkles size={14}/>{classificationNote || 'AI suggestions are optional and require resident review. No cleanup cost is estimated.'}</p><div className="detail-actions"><button className="button button-outline support-wide" onClick={() => onSupport(report)}><ThumbsUp size={15}/> Support this report · {report.supports}</button><button className="button button-outline" onClick={onAsk} title="Use the field guide to look for possible duplicates"><Sparkles size={15}/> Check nearby</button></div></div></div>
      {report.is_owner_view && <section className="photo-sharing-panel"><div><b>{report.photo_public ? 'Your photo is shared with the community' : 'Your photo is currently private'}</b><p>{report.photo_public ? 'You can stop sharing it here. Previously downloaded copies cannot be recalled.' : 'Help neighbors understand this site. Check the photo for personal details before sharing it publicly.'}</p></div><button type="button" className="button button-outline" disabled={saving} onClick={changePhotoSharing}>{report.photo_public ? 'Stop sharing photo' : 'Share photo publicly'}</button>{sharingError && <p className="tool-error" role="alert">{sharingError}</p>}</section>}
      <CommunityThread focusCompose={focusComments} key={report.id} report={report} api={API} getClientToken={clientToken} onAsk={onPlan}/>
      <p className="draft-message" role="status">Report saved. <a href={`#report/${report.id}`}>Open saved report</a> · {report.id}</p>
      {report.is_owner_view && Object.values(enrichment).some((step) => step.status !== 'complete') && <section className="report-recovery" aria-label="Saved report next steps"><div><Check size={16}/><b>Report saved · {report.id.slice(0, 8).toUpperCase()}</b></div><p>Your photo and location are saved. Optional steps can be retried here using this report.</p>{ENRICHMENT_STEPS.filter((step) => enrichment[step.key] && enrichment[step.key].status !== 'complete').map((step) => <div className="report-recovery-step" key={step.key}><span role={enrichment[step.key].status === 'unavailable' ? 'status' : undefined}>{enrichment[step.key].message}</span>{enrichment[step.key].status === 'unavailable' && <button className="button button-outline" disabled={saving || submissionLocked} onClick={() => onRetryEnrichment(report, step.key)}>Retry {step.label.toLowerCase()} <RefreshCw size={13}/></button>}</div>)}</section>}
      <section className="recovery-panel"><div className="recovery-heading"><div><div className="eyebrow muted">WASTE → RECYCLE / ENERGY</div><h3>Check the material and route</h3></div>{report.is_owner_view && <button className="button button-outline" disabled={saving || submissionLocked} onClick={runPhotoClassification}>{saving ? <><span className="button-loader"/> Checking…</> : <><Sparkles size={14}/> Analyze photo with Bedrock</>}</button>}</div>
        <p className="recovery-explainer">Bedrock output is an AI suggestion. Review the category and rough visual mass class before using it. {report.is_owner_view ? '' : 'This is a public summary; exact location and edit controls are private to the reporter.'}</p>
        {report.is_owner_view && <><div className="recovery-controls"><label className="field-label">MATERIAL CATEGORY<select className="text-input" value={materialCategory} onChange={(e) => setMaterialCategory(e.target.value)}>{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="field-label">ROUGH MASS ESTIMATE<select className="text-input" value={massClass} onChange={(e) => setMassClass(e.target.value)}><option value="small">Small · 1–5 kg</option><option value="medium">Medium · 5–25 kg</option><option value="large">Large · 25–100 kg</option></select></label></div><div className="assessment-footer"><span>Illustrative class only. Confirm category and weight in person.</span><button className="button button-green" disabled={saving || submissionLocked} onClick={saveRecoveryChoice}>{saving ? 'Saving…' : <>Save resident review <Check size={14}/></>}</button></div></>}
        {report.classification?.material_category && <p className="analysis-note"><Sparkles size={14}/>{report.classification.visual_note} · {report.classification.review_required ? 'AI suggestion; review required.' : 'Resident reviewed.'}</p>}
        {route && <div className="route-card"><div><b>{route.title}</b><span>{route.advice}</span><small>Availability: {route.availability.replaceAll('_', ' ')} · sourced {route.verified_on}</small><a href={route.source_url} target="_blank" rel="noreferrer">Review source ↗</a>{route.url && <a href={route.url} target="_blank" rel="noreferrer">Open CPCB e-waste portal ↗</a>}</div></div>}
        <div className="impact-card"><b>{impact ? `Estimated potential: ${impact.min}–${impact.max} kg CO₂e avoided if diverted` : 'CO₂e estimate not configured for this material'}</b><span>{report.impact?.assumption || 'WasteLens only calculates a cited estimate for organic material when a mass class is saved. This is not measured or confirmed diversion.'}</span>{impact && <><small>{report.impact.formula}</small><a href={report.impact.factor_source_url} target="_blank" rel="noreferrer">Factor source · EPA WARM v16 ↗</a><small>{report.impact.factor_scope}</small></>}</div>
      </section>
      <div className="authority-note"><ShieldCheck size={16}/><div><b>{authority ? authority.name : 'Authority directory not configured for this location'}</b><span>{authority ? authority.scope_note : (authorityMatch.scope_note || 'Coordinates did not match the approximate Lucknow pilot extent. No municipal contact is suggested.')}</span><span>{authorityMatch.match_basis || 'Location match unavailable.'}</span>{authorityMatch.boundary_source_url && <a href={authorityMatch.boundary_source_url} target="_blank" rel="noreferrer">Review approximate boundary data ↗</a>}{authority?.channels?.map((channel) => channel.url ? <a key={channel.type} href={channel.url} target="_blank" rel="noreferrer">Open official complaint portal ↗</a> : <span key={channel.value}>{channel.label}: {channel.value}</span>)}{authority?.source_url && <a className="source-link" href={authority.source_url} target="_blank" rel="noreferrer">Official contact source ↗</a>}</div></div>
      {report.is_owner_view ? <><div className="assessment-box"><label className="field-label">WASTE CATEGORIES <span>AI labels need resident review</span></label><input className="text-input" value={categories} disabled={submissionLocked || saving} onChange={(e) => { setCategories(e.target.value); setAssessmentMessage('') }} placeholder="e.g. plastic, food waste"/><label className="field-label severity-label">SEVERITY ASSESSMENT</label><select className="text-input" value={severity} disabled={submissionLocked || saving} onChange={(e) => { setSeverity(e.target.value); setAssessmentMessage('') }}><option value="unassessed">Unassessed</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select><div className="assessment-footer"><span>Severity is a resident estimate; image AI does not infer it.</span><button className="button button-outline" disabled={saving || submissionLocked} onClick={saveAssessment}>{saving ? <><span className="button-loader"/> Saving…</> : <>Save assessment <Check size={15}/></>}</button></div>{assessmentMessage && <p className="draft-message" role={assessmentFailed ? "alert" : "status"}>{assessmentMessage}</p>}</div><section className="complaint-print-area"><label className="field-label complaint-label"><FileText size={14}/> COMPLAINT DRAFT <span>Review and edit before sending</span></label><textarea className="complaint-editor" value={draft} readOnly={submissionLocked} disabled={saving} onChange={(e) => { setDraft(e.target.value); setDraftMessage(''); setDraftFailed(false); setConfirmJurisdiction(false); setConfirmSend(false); setSendMessage('') }} rows="6"/><div className="draft-footer"><span><ShieldCheck size={14}/> {submissionLocked ? 'Complaint is locked after the send attempt' : 'Not sent until you approve the final email'}</span><div className="complaint-print-actions"><button type="button" className="button button-outline" onClick={copyDraft}><Clipboard size={14}/> Copy</button><button type="button" className="button button-outline" onClick={printDraft}><Printer size={14}/> Print</button><button type="button" className="button button-green" disabled={saving || submissionLocked} onClick={saveDraft}>{saving ? <><span className="button-loader"/> Saving…</> : <>Save changes <Check size={15}/></>}</button></div></div>{draftMessage && <p className="draft-message" role={draftFailed ? "alert" : "status"}>{draftMessage}</p>}</section>
        <section className="submission-card" aria-labelledby="submission-title"><div className="submission-heading"><div><div className="eyebrow muted">OPTIONAL EXTERNAL ACTION</div><h3 id="submission-title">Send the approved complaint by email</h3></div><span className={`submission-state submission-${submissionState}`}>{submissionState.replaceAll('_', ' ')}</span></div>
          <p>Sender: <b>{emailService?.sender || 'not configured'}</b>. Destination: LNN’s published public contact email, <b>{emailService?.recipient || 'nnlko@nic.in'}</b>. It is not identified as a complaint ticket inbox. This email includes the complaint text, report ID <b>{report.id}</b>, address <b>{report.address || 'not provided'}</b>, exact coordinates <b>{Number(report.latitude).toFixed(5)}, {Number(report.longitude).toFixed(5)}</b>, categories <b>{(report.categories || []).join(', ') || 'not assessed'}</b>, and resident severity <b>{report.severity || 'unassessed'}</b>. The photo and your email address are not attached.</p>
          {emailService?.source_url && <a className="source-link" href={emailService.source_url} target="_blank" rel="noreferrer">Verify the published contact ↗</a>}
          {submissionState === 'email_accepted' && <div className="submission-result success"><Check size={15}/><span>Email sent to {report.submission_recipient || emailService?.recipient || 'the published LNN contact'} and accepted by Amazon SES for delivery. LNN receipt, acknowledgment and ticket creation are not guaranteed.</span></div>}
          {submissionState === 'sending' && <div className="submission-result"><Clock3 size={15}/><span>WasteLens is recording the send result. Do not send again. Refresh this report before taking another action.</span></div>}
          {submissionState === 'delivery_unknown' && <div className="submission-result warning"><CircleHelp size={15}/><span>Email delivery could not be confirmed. WasteLens has blocked a duplicate send. Follow up through LNN’s published contact channel.</span></div>}
          {submissionState === 'delivery_failed' && <div className="submission-result warning"><CircleHelp size={15}/><span>Amazon SES rejected the email; no message was accepted. The deployment needs a working SES sender and permission before trying again.</span></div>}
          {submissionState === 'not_sent' && !emailService?.available && <div className="submission-result warning"><CircleHelp size={15}/><span>Email delivery is not configured in this deployment. No email has been sent. You can copy the draft above or use LNN’s official portal.</span></div>}
          {submissionState === 'not_sent' && emailService?.available && !authority && <div className="submission-result warning"><CircleHelp size={15}/><span>No verified Lucknow authority match is available for this report location. No email contact is suggested.</span></div>}
          {submissionState === 'not_sent' && submissionEligible && <p className="submission-note">Nothing has been sent yet. SES availability is configured for this deployment; permissions are checked when you send.</p>}
          {['not_sent', 'delivery_failed'].includes(submissionState) && submissionEligible && <div className="submission-confirmations">{assessmentDirty && <p className="submission-note">Save your category and severity review first. The email uses the saved report details shown above.</p>}<label><input type="checkbox" checked={confirmJurisdiction} disabled={saving} onChange={(e) => setConfirmJurisdiction(e.target.checked)}/><span>I checked the exact address and coordinates and confirm this site is within Lucknow Nagar Nigam’s jurisdiction.</span></label><label><input type="checkbox" checked={confirmSend} disabled={saving} onChange={(e) => setConfirmSend(e.target.checked)}/><span>I reviewed the complaint above and authorize WasteLens to email this exact text and location to {emailService.recipient}.</span></label><button type="button" className="button button-green" disabled={saving || assessmentDirty || !confirmJurisdiction || !confirmSend || !draft.trim()} onClick={submitComplaint}>{saving ? <><span className="button-loader"/> Sending email…</> : <>{submissionState === 'delivery_failed' ? 'Retry email to LNN' : 'Confirm & send email to LNN'} <ArrowRight size={15}/></>}</button></div>}
          {sendMessage && <p className="submission-feedback" role="status">{sendMessage}</p>}
        </section></> : <p className="private-note"><ShieldCheck size={15}/> Everyone can join the discussion. Only the reporter can edit the assessment, exact location and complaint draft.</p>}
    </div>
  </div>
}

function AssistantPanel({ status, messages, input, busy, context, endRef, onClose, onInput, onSubmit, onClearContext }) {
  const suggestions = [
    'Who can I contact in Lucknow?',
    'Summarize the community board',
    context ? 'Check for possible nearby duplicates' : 'How can I make a useful report?',
  ]
  return <aside className="assistant-panel" aria-label="WasteLens field guide"><div className="assistant-head"><span className="assistant-avatar"><Bot size={18}/></span><div className="assistant-heading"><b>WasteLens field guide</b><span><i className={status.ready ? 'ai-indicator ready' : 'ai-indicator'}/>{status.ready ? 'AWS Bedrock · grounded help plans' : 'Lucknow community guide'}</span></div><button className="icon-button" onClick={onClose} aria-label="Close field guide"><X size={18}/></button></div>{context && <div className="context-pill"><MapPin size={13}/> Looking at report {context.id.slice(0, 6).toUpperCase()}<button onClick={onClearContext} aria-label="Clear report context"><X size={12}/></button></div>}<div className="assistant-feed">{messages.map((message, index) => <div className={`chat-row ${message.role}`} key={`${index}-${message.role}`}><span className="chat-avatar">{message.role === 'assistant' ? <Sparkles size={13}/> : 'You'}</span><div className="chat-bubble">{message.text}{message.mode && <small className="answer-mode">{message.mode}</small>}</div></div>)}{busy && <div className="chat-row assistant"><span className="chat-avatar"><Sparkles size={13}/></span><div className="chat-bubble typing"><i/><i/><i/></div></div>}<div ref={endRef}/></div><div className="suggestion-row">{suggestions.map((suggestion) => <button key={suggestion} disabled={busy} onClick={(e) => onSubmit(e, suggestion)}>{suggestion}</button>)}</div><form className="assistant-compose" onSubmit={(e) => onSubmit(e)}><textarea aria-label="Ask the WasteLens field guide" placeholder="Ask about reports or next steps…" value={input} onChange={(e) => onInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(e) } }} rows="1"/><button type="submit" disabled={busy || !input.trim()} aria-label="Send question"><Send size={16}/></button></form><p className="ai-privacy"><ShieldCheck size={12}/>{status.ready ? 'Bedrock sees your question to select relevant help topics. Verified answers are assembled locally; report data stays in WasteLens. Avoid names and exact addresses.' : 'Guidance uses verified Lucknow pilot sources and community reports. Check local details before acting.'}</p></aside>
}

export default App
