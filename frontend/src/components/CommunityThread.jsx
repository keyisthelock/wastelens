import { useEffect, useRef, useState } from 'react'
import { MessageCircle, Send, RefreshCw, Sparkles } from 'lucide-react'
import { requestJson } from '../report-workflow.js'
import { ownerHeaders } from '../owner-tokens.js'

export default function CommunityThread({ report, api, getClientToken, onAsk, focusCompose = false }) {
  const composeRef = useRef(null)
  useEffect(() => { if (focusCompose) { composeRef.current?.scrollIntoView({ block: 'center' }); composeRef.current?.focus({ preventScroll: true }) } }, [focusCompose])
  const [comments, setComments] = useState([])
  const [author, setAuthor] = useState('')
  const [body, setBody] = useState('')
  const [attempt, setAttempt] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [plan, setPlan] = useState(null)
  const [message, setMessage] = useState('')
  const refresh = async () => {
    setLoading(true)
    try {
      const result = await requestJson(fetch, `${api}/reports/${report.id}/comments`,
        { headers: { 'X-Client-Token': getClientToken() } }, 'Discussion could not refresh. Your message is still here.')
      if (!Array.isArray(result.comments)) throw new Error('Discussion response could not be read.')
      setComments(result.comments); setError('')
    } catch (error) { setError(error.message) }
    finally { setLoading(false) }
  }
  useEffect(() => { void refresh() }, [report.id])
  const post = async (event) => {
    event.preventDefault()
    if (busy || !body.trim()) return
    const current = attempt || { id: crypto.randomUUID(), author: author.trim() || 'Neighbor', body: body.trim() }
    setAttempt(current); setBusy(true); setError(''); setMessage('')
    try {
      const result = await requestJson(fetch, `${api}/reports/${report.id}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client-Token': getClientToken() },
        body: JSON.stringify(current),
      }, 'Posting could not be confirmed. Retry this same message safely.')
      if (result.comment?.id !== current.id || result.comment?.body !== current.body) throw new Error('The server did not confirm this message. Retry the same message.')
      setComments((items) => [...items.filter((item) => item.id !== current.id), result.comment])
      setBody(''); setAttempt(null); setMessage('Message posted to the community.')
    } catch (error) {
      if ([400, 401, 403, 409, 422].includes(error.status)) setAttempt(null)
      setError(error.message)
    } finally { setBusy(false) }
  }
  const remove = async (comment) => {
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await requestJson(fetch, `${api}/reports/${report.id}/comments/${comment.id}`, {
        method: 'DELETE', headers: ownerHeaders(report.id, { 'X-Client-Token': getClientToken() }),
      }, 'Could not remove this message. Try again.')
      if (result.removed !== true) throw new Error('Removal was not confirmed.')
      setComments((items) => items.filter((item) => item.id !== comment.id))
    } catch (error) { setError(error.message) }
    finally { setBusy(false) }
  }
  const solutions = async () => {
    setBusy(true); setError('')
    try {
      const result = await requestJson(fetch, `${api}/reports/${report.id}/solutions`, {}, 'Solution guidance is unavailable. Try again.')
      if (!Array.isArray(result.steps)) throw new Error('Solution guidance could not be read.')
      setPlan(result)
    } catch (error) { setError(error.message) }
    finally { setBusy(false) }
  }
  return <section className="community-thread" aria-label="Community discussion">
    <div className="recovery-heading"><div><div className="eyebrow muted">TOGETHER, FOR THIS STREET</div><h3><MessageCircle size={20}/> Community discussion</h3></div><button type="button" className="icon-button" disabled={loading || busy} onClick={refresh} aria-label="Refresh discussion"><RefreshCw size={17}/></button></div>
    <p className="thread-intro">Share observations, suggest a next step, or coordinate an approved cleanup. Messages are public; keep personal contact details and exact home addresses out of them.</p>
    <div className="thread-actions"><button type="button" className="button button-green" disabled={busy} onClick={solutions}><Sparkles size={15}/> Build a solution together</button><button type="button" className="button button-outline" onClick={onAsk}>Ask WasteLens</button></div>
    {plan && <div className="community-plan"><span className="tool-kicker">LOCAL GUIDANCE · AI NOT USED</span><ol>{plan.steps.map((step) => <li key={step}>{step}</li>)}</ol>{plan.recovery_route && <p><b>{plan.recovery_route.title}</b><br/>{plan.recovery_route.advice}<br/><a href={plan.recovery_route.source_url} target="_blank" rel="noreferrer">Read the handling source ↗</a></p>}<small>{plan.note}</small></div>}
    {loading && <p role="status">Loading discussion…</p>}
    {!loading && !error && !comments.length && <div className="thread-empty">Be the first neighbor to suggest a next step.</div>}
    <ul className="thread-messages">{comments.map((comment) => <li key={comment.id}><div className="thread-message-head"><b>{comment.author}</b><small>Community alias · unverified</small><time dateTime={comment.created_at}>{new Date(comment.created_at).toLocaleDateString()}</time></div><p>{comment.body}</p>{(comment.is_author || report.is_owner_view) && <button type="button" className="locate-link" disabled={busy} onClick={() => remove(comment)}>Remove message</button>}</li>)}</ul>
    <form className="thread-compose" onSubmit={post}><label>Your community alias<input className="text-input" value={author} maxLength={40} disabled={busy || Boolean(attempt)} onChange={(event) => setAuthor(event.target.value)} placeholder="Neighbor"/></label><label>Add a comment<textarea ref={composeRef} className="text-input" required rows={3} maxLength={1200} value={body} disabled={busy || Boolean(attempt)} onChange={(event) => setBody(event.target.value)} placeholder="What could we do together about this site?"/></label><button className="button button-dark" disabled={busy || !body.trim()}><Send size={15}/>{busy ? 'Saving…' : attempt ? 'Retry this message safely' : 'Post comment'}</button></form>
    {error && <p className="tool-error" role="alert">{error}</p>}{message && <p className="draft-message" role="status">{message}</p>}
  </section>
}
