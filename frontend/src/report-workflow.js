export const ENRICHMENT_STEPS = [
  { key: 'analyze', label: 'Waste analysis', failure: 'Report saved; analysis unavailable. Retry analysis or enter your assessment below.' },
  { key: 'classify', label: 'Photo classification', failure: 'Photo classification unavailable. Retry it or choose a material category below.' },
  { key: 'complaint', label: 'Complaint draft', failure: 'Complaint drafting unavailable. Retry it or write your draft below.' },
]

// Reopening a persisted owner report must also expose unfinished optional steps.
export function storedReportRecovery(report) {
  if (!report.is_owner_view) return {}
  const missing = {
    analyze: !report.analysis_note || /unavailable|not configured/i.test(report.analysis_note),
    classify: !report.classification?.material_category,
    complaint: !report.complaint?.trim(),
  }
  return Object.fromEntries(ENRICHMENT_STEPS.filter((step) => missing[step.key]).map((step) => [step.key,
    { status: 'unavailable', message: `${step.failure} ${step.key === 'analyze' ? report.analysis_note || '' : ''}`.trim() }]))
}

export const reviewedCategories = (input) => [...new Set(input.split(',').map((value) => value.trim()).filter(Boolean))]

export const retainCreatedReport = (savedReports, report) => ({ ...savedReports, [report.id]: requireReport(report) })
export const savedReportsMissingFromBoard = (savedReports, boardReports) => {
  const boardIds = new Set(boardReports.map((report) => report.id))
  return Object.values(savedReports).filter((report) => !boardIds.has(report.id))
}

export function requireReport(report, expectedId) {
  if (!report || typeof report.id !== 'string' || !report.id || (expectedId && report.id !== expectedId)
    || !Array.isArray(report.categories) || !report.categories.every((category) => typeof category === 'string')
    || typeof report.severity !== 'string' || typeof report.status !== 'string'
    || !Number.isFinite(report.latitude) || !Number.isFinite(report.longitude)
    || !Number.isInteger(report.supports) || report.supports < 0
    || typeof report.created_at !== 'string' || !Number.isFinite(Date.parse(report.created_at))
    || (report.is_owner_view && typeof report.complaint !== 'string')) {
    throw new Error('The server did not confirm the saved report. Your edits are still here; retry this step.')
  }
  return report
}

export async function requestJson(fetchImpl, url, options, failure) {
  let response
  try { response = await fetchImpl(url, options) }
  catch { throw new Error(failure) }
  let result
  try { result = await response.json() }
  catch { throw new Error(`${failure} The server returned an unreadable response.`) }
  if (!response.ok) {
    const error = new Error(typeof result?.detail === 'string' ? result.detail : failure)
    error.status = response.status
    throw error
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(`${failure} The server returned an incomplete response.`)
  return result
}

export async function createReport({ api, cloud, photo, location, pendingUpload, preparePhoto,
  rememberOwnerToken, ownerHeaders, onPending = () => {}, fetchImpl = globalThis.fetch }) {
  if (!cloud && (!pendingUpload || pendingUpload.mode === 'local')) {
    const attempt = pendingUpload || { reportId: crypto.randomUUID(), mode: 'local' }
    if (!pendingUpload) {
      rememberOwnerToken(attempt.reportId, crypto.randomUUID() + crypto.randomUUID())
      onPending(attempt)
    }
    const body = new FormData()
    body.append('photo', photo)
    body.append('report_id', attempt.reportId)
    for (const [key, value] of Object.entries(location)) body.append(key, typeof value === 'boolean' ? String(value) : value)
    let created
    try {
      created = await requestJson(fetchImpl, `${api}/reports`, { method: 'POST', body, headers: ownerHeaders(attempt.reportId) }, 'Creation could not be confirmed. Retry to recover the same report ID.')
    } catch (error) {
      if ([400, 413, 415, 422].includes(error.status)) onPending(null)
      throw error
    }
    rememberOwnerToken(created.id, created.owner_token)
    const { owner_token, ...report } = created
    const saved = requireReport(report)
    onPending(null)
    return saved
  }

  // An existing pending upload is retried by ID, never deleted on a lost response.
  let upload = pendingUpload
  const confirm = async () => {
    const report = requireReport(await requestJson(fetchImpl, `${api}/reports/${upload.reportId}/confirm-upload`, {
      method: 'POST', headers: ownerHeaders(upload.reportId),
    }, 'Photo confirmation is unavailable. Your report ID is retained; retry confirmation.'), upload.reportId)
    if (report.upload_state !== 'ready') throw new Error('Your photo is still pending. Retry confirmation for this report.')
    onPending(null)
    return report
  }
  if (upload && !upload.creating) {
    try { return await confirm() }
    catch (error) {
      const missingOrInvalidPhoto = [413, 415].includes(error.status)
        || (error.status === 409 && error.message.includes('has not reached private storage yet'))
      if (!missingOrInvalidPhoto) throw error
    }
    const renewed = await requestJson(fetchImpl, `${api}/reports/${upload.reportId}/upload-url`, {
      method: 'POST', headers: ownerHeaders(upload.reportId),
    }, 'Could not renew the photo upload. Your report ID is retained; retry later.')
    const current = requireReport(renewed.report, upload.reportId)
    if (current.upload_state === 'ready') { onPending(null); return current }
    if (typeof renewed.upload_url !== 'string' || typeof renewed.upload_content_type !== 'string') {
      throw new Error('The server did not provide a renewed photo upload URL. Your report ID is retained.')
    }
    upload = { ...upload, uploadUrl: renewed.upload_url, contentType: renewed.upload_content_type, uploaded: false }
    onPending(upload)
  }
  const jpeg = upload?.uploaded ? null : await preparePhoto(photo)
  if (!upload || upload.creating) {
    if (!upload) {
      upload = { reportId: crypto.randomUUID(), creating: true }
      rememberOwnerToken(upload.reportId, crypto.randomUUID() + crypto.randomUUID())
      onPending(upload)
    }
    let created
    try { created = await requestJson(fetchImpl, `${api}/reports/upload-url`, {
      method: 'POST', headers: ownerHeaders(upload.reportId, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ report_id: upload.reportId, ...location, latitude: Number(location.latitude), longitude: Number(location.longitude) }),
    }, 'Creation could not be confirmed. Retry to recover the same report ID.') }
    catch (error) {
      if ([400, 413, 415, 422].includes(error.status)) onPending(null)
      throw error
    }
    const reportId = created.report?.id
    if (typeof reportId !== 'string' || !reportId) throw new Error('The server did not provide a report ID.')
    // Keep the issued capability and ID before validating optional response fields.
    rememberOwnerToken(reportId, created.owner_token)
    upload = { reportId, uploadUrl: typeof created.upload_url === 'string' ? created.upload_url : '',
      contentType: typeof created.upload_content_type === 'string' ? created.upload_content_type : '', uploaded: false }
    onPending(upload)
    requireReport(created.report)
    if (created.report.upload_state === 'ready') { onPending(null); return created.report }
    if (typeof created.upload_url !== 'string' || typeof created.upload_content_type !== 'string') {
      throw new Error('The server did not provide a photo upload URL. Your report ID is retained; retry this report.')
    }
  }
  if (!upload.uploaded) {
    let sent
    try { sent = await fetchImpl(upload.uploadUrl, { method: 'PUT', headers: { 'Content-Type': upload.contentType }, body: jpeg }) }
    catch { throw new Error('Photo upload could not be confirmed. Retry the upload for this report.') }
    if (!sent.ok) throw new Error('Photo upload failed. Retry the upload for this report.')
    upload = { ...upload, uploaded: true }
    onPending(upload)
  }
  return confirm()
}

export async function enrichReport({ api, report: savedReport, steps = ENRICHMENT_STEPS.map((step) => step.key),
  ownerHeaders, onReport = () => {}, onStep = () => {}, fetchImpl = globalThis.fetch }) {
  let report = requireReport(savedReport)
  const outcomes = {}
  for (const step of ENRICHMENT_STEPS.filter((item) => steps.includes(item.key))) {
    onStep(step.key, { status: 'running', message: `${step.label} is running…` })
    try {
      const result = await requestJson(fetchImpl, `${api}/reports/${report.id}/${step.key}`, {
        method: 'POST', headers: ownerHeaders(report.id, { 'Content-Type': 'application/json' }), body: '{}',
      }, step.failure)
      if (step.key !== 'complaint' && typeof result.analysis_available !== 'boolean') throw new Error(step.failure)
      const updated = requireReport(result.report, report.id)
      if (step.key === 'complaint' && (typeof updated.complaint !== 'string' || !updated.complaint.trim())) {
        throw new Error(step.failure)
      }
      report = updated
      onReport(report)
      outcomes[step.key] = result.analysis_available === false && step.key !== 'complaint'
        ? { status: 'unavailable', message: `${step.failure} ${result.note || ''}`.trim() }
        : { status: 'complete', message: `${step.label} is ready for review.` }
    } catch { outcomes[step.key] = { status: 'unavailable', message: step.failure } }
    onStep(step.key, outcomes[step.key])
  }
  return { report, outcomes }
}

export async function finishReportCreation({ report, onCreated, refreshBoard, ...enrichmentOptions }) {
  onCreated(requireReport(report))
  const enriched = await enrichReport({ ...enrichmentOptions, report })
  let boardRefreshed = false
  try { boardRefreshed = await refreshBoard() !== false }
  catch { /* A board outage cannot change the outcome of report creation. */ }
  return { ...enriched, boardRefreshed }
}

export async function saveReportDraft({ api, report, draft, ownerHeaders, fetchImpl = globalThis.fetch }) {
  const result = await requestJson(fetchImpl, `${api}/reports/${report.id}/complaint`, {
    method: 'POST', headers: ownerHeaders(report.id, { 'Content-Type': 'application/json' }), body: JSON.stringify({ draft }),
  }, 'Could not save your complaint draft. Your text is still here; try again.')
  const updated = requireReport(result.report, report.id)
  if (updated.complaint !== draft.trim()) throw new Error('The server did not confirm your draft text. Your text is still here; retry saving.')
  return updated
}

export async function saveReportAssessment({ api, report, categories, severity, ownerHeaders, fetchImpl = globalThis.fetch }) {
  const result = await requestJson(fetchImpl, `${api}/reports/${report.id}/analyze`, {
    method: 'POST', headers: ownerHeaders(report.id, { 'Content-Type': 'application/json' }), body: JSON.stringify({ categories, severity }),
  }, 'Could not save your assessment. Your entries are still here; try again.')
  const updated = requireReport(result.report, report.id)
  if (updated.severity !== severity || JSON.stringify(updated.categories) !== JSON.stringify(categories)) {
    throw new Error('The server did not confirm your assessment. Your entries are still here; retry saving.')
  }
  return updated
}

// UI controls are released for transport, HTTP, and response validation failures alike.
export async function runConfirmedSave({ save, setSaving, onSaved, onError, clearFeedback = () => {} }) {
  setSaving(true)
  try {
    clearFeedback()
    const updated = requireReport(await save())
    onSaved(updated)
    return updated
  } catch (error) {
    onError(error.message || 'Saving is unavailable. Your edits are still here; try again.')
    return null
  } finally { setSaving(false) }
}
