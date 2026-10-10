import test from 'node:test'
import assert from 'node:assert/strict'
import { createOwnerTokenStore } from '../src/owner-tokens.js'
import { createReport, enrichReport, finishReportCreation, reviewedCategories, retainCreatedReport, savedReportsMissingFromBoard, runConfirmedSave, saveReportDraft, saveReportAssessment } from '../src/report-workflow.js'

const api = '/api'
const original = { id: 'report-one', categories: [], severity: 'unassessed', status: 'community_reported',
  complaint: '', is_owner_view: true, upload_state: 'ready', latitude: 26.8467, longitude: 80.9462,
  supports: 0, created_at: '2026-10-10T12:00:00+00:00', address: 'Lucknow pilot site', image_path: '/api/reports/report-one/photo' }
const location = { latitude: '26.8467', longitude: '80.9462', address: 'Lucknow pilot site' }
const photo = new Blob(['example photo'], { type: 'image/jpeg' })
const json = (result, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => result })
const unavailable = () => { throw new TypeError('Network request failed') }
const unreadable = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Invalid JSON') } })
const fakeStorage = () => {
  const data = new Map()
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }
}

test('owner authorization survives a blocked sessionStorage getter, reads, and writes', async (t) => {
  for (const [name, getStorage] of [
    ['getter', () => { throw new Error('SecurityError') }],
    ['read', () => ({ getItem: unavailable, setItem() {} })],
    ['write', () => ({ getItem: () => '{}', setItem: unavailable })],
  ]) await t.test(name, () => {
    const tokens = createOwnerTokenStore(getStorage)
    tokens.rememberOwnerToken(original.id, 'private-owner-capability')
    assert.equal(tokens.ownerToken(original.id), 'private-owner-capability')
    assert.deepEqual(tokens.ownerHeaders(original.id, { 'Content-Type': 'application/json' }), {
      'Content-Type': 'application/json', 'X-Report-Token': 'private-owner-capability',
    })
    assert.deepEqual(tokens.ownerHeaders('another-report'), {})
  })
})

test('owner tokens survive a session reload and malformed storage cannot remove an issued memory token', () => {
  const storage = fakeStorage()
  const firstPage = createOwnerTokenStore(() => storage)
  firstPage.rememberOwnerToken(original.id, 'private-owner-capability')
  const nextPage = createOwnerTokenStore(() => storage)
  assert.equal(nextPage.ownerToken(original.id), 'private-owner-capability')
  for (const malformed of ['not-json', 'null', '[]', '{"other": 123}', '{"report-one": false}']) {
    storage.setItem('wastelens-owner-tokens', malformed)
    assert.equal(firstPage.ownerToken(original.id), 'private-owner-capability')
    const page = createOwnerTokenStore(() => storage)
    assert.equal(page.ownerToken(original.id), '')
    page.rememberOwnerToken(original.id, 'new-private-owner-capability')
    assert.equal(page.ownerToken(original.id), 'new-private-owner-capability')
  }
})

for (const failedStep of ['analyze', 'classify', 'complaint']) {
  test(`a network failure during ${failedStep} keeps the created report available and retries its ID`, async () => {
    const tokens = createOwnerTokenStore(() => { throw new Error('Storage blocked') })
    const calls = []
    let visibleReport = null
    let retry = false
    const outcomes = {}
    const fetchImpl = async (url, options) => {
      calls.push({ url, options })
      if (url === `${api}/reports`) return json({ ...original, owner_token: 'private-owner-capability' }, 201)
      assert.equal(visibleReport?.id, original.id, 'the created report is shown before optional requests')
      assert.equal(options.headers['X-Report-Token'], 'private-owner-capability')
      if (url.endsWith(`/${failedStep}`) && !retry) return unavailable()
      const report = url.endsWith('/complaint') ? { ...original, complaint: 'Review this complaint.' } : original
      return json({ report, analysis_available: true })
    }
    const created = await createReport({ api, cloud: false, photo, location, ...tokens, fetchImpl })
    assert.equal(Object.hasOwn(created, 'owner_token'), false, 'tokens are removed from the displayed report')
    const result = await finishReportCreation({ api, report: created, ownerHeaders: tokens.ownerHeaders, fetchImpl,
      onCreated: (report) => { visibleReport = report }, onReport: (report) => { visibleReport = report },
      onStep: (step, outcome) => { outcomes[step] = outcome },
      refreshBoard: unavailable,
    })
    assert.equal(visibleReport.id, created.id)
    assert.equal(result.report.id, created.id)
    assert.equal(result.boardRefreshed, false)
    assert.equal(outcomes[failedStep].status, 'unavailable')
    assert.match(outcomes.analyze.message, failedStep === 'analyze' ? /Report saved; analysis unavailable/ : /ready/)
    retry = true
    const retried = await enrichReport({ api, report: visibleReport, steps: [failedStep], ownerHeaders: tokens.ownerHeaders,
      fetchImpl, onReport: (report) => { visibleReport = report } })
    assert.equal(retried.outcomes[failedStep].status, 'complete')
    assert.equal(calls.filter((call) => call.url === `${api}/reports`).length, 1)
    assert.equal(calls.at(-1).url, `${api}/reports/${created.id}/${failedStep}`)
    assert.ok(calls.every((call) => !call.url.includes('private-owner-capability')))
  })
}

test('optional HTTP, malformed, and AI-unavailable results do not discard the saved report', async () => {
  const outcomes = {}
  let visibleReport = null
  const result = await finishReportCreation({ api, report: original, ownerHeaders: () => ({}),
    onCreated: (report) => { visibleReport = report }, onReport: (report) => { visibleReport = report },
    onStep: (step, outcome) => { outcomes[step] = outcome }, refreshBoard: async () => false,
    fetchImpl: async (url) => {
      if (url.endsWith('/analyze')) return json({ detail: 'Unavailable' }, 503)
      if (url.endsWith('/classify')) return json({ report: original, analysis_available: false })
      return json({ report: null })
    },
  })
  assert.equal(visibleReport, original)
  assert.equal(result.report.id, original.id)
  assert.equal(result.boardRefreshed, false)
  assert.deepEqual(Object.values(outcomes).map((value) => value.status), ['unavailable', 'unavailable', 'unavailable'])
})

test('the saved owner report remains reopenable after closing details during a board outage', async () => {
  const publicBoard = []
  let createdReports = {}
  let selected = null
  const enrichedReport = { ...original, categories: ['plastic'] }
  await finishReportCreation({ api, report: original, steps: ['analyze'], ownerHeaders: () => ({}),
    onCreated: (report) => { createdReports = retainCreatedReport(createdReports, report); selected = report },
    onReport: (report) => { createdReports = retainCreatedReport(createdReports, report); selected = report },
    fetchImpl: async () => json({ report: enrichedReport, analysis_available: true }), refreshBoard: unavailable,
  })
  selected = null
  const recoveryReports = savedReportsMissingFromBoard(createdReports, publicBoard)
  assert.equal(recoveryReports.length, 1)
  assert.equal(recoveryReports[0].id, original.id)
  assert.deepEqual(recoveryReports[0].categories, ['plastic'])
  assert.deepEqual(publicBoard, [], 'private report data is not added to the public board')
  selected = recoveryReports[0]
  assert.equal(selected.is_owner_view, true)
  assert.deepEqual(savedReportsMissingFromBoard(createdReports, [{ id: original.id }]), [])
})

for (const step of ['analyze', 'classify']) {
  test(`${step} without an explicit boolean availability flag remains recoverable`, async () => {
    let replacements = 0
    const result = await enrichReport({ api, report: original, steps: [step], ownerHeaders: () => ({}),
      onReport: () => { replacements++ }, fetchImpl: async () => json({ report: { ...original, categories: ['plastic'] } }),
    })
    assert.equal(result.report, original)
    assert.equal(result.outcomes[step].status, 'unavailable')
    assert.equal(replacements, 0)
  })
}

const saveFailures = [
  ['network', unavailable],
  ['HTTP 503', () => json({ detail: 'Saving is temporarily unavailable. Your edits are still here.' }, 503)],
  ['unreadable JSON', unreadable],
  ['missing report', () => json({})],
  ['null report', () => json({ report: null })],
  ['wrong report ID', () => json({ report: { ...original, id: 'another-report' } })],
  ['missing display fields', () => json({ report: { ...original, latitude: undefined, created_at: undefined } })],
]
for (const kind of ['draft', 'assessment']) {
  test(`${kind} save failures always restore controls and retain unsaved input`, async (t) => {
    for (const [failure, fetchImpl] of saveFailures) await t.test(failure, async () => {
      const unsaved = { draft: '  Please clean the waste on our street.  ', categories: ' plastic, food waste, plastic ', severity: 'high' }
      const input = { ...unsaved }
      const controls = []
      let message = ''
      let successes = 0
      const save = () => kind === 'draft'
        ? saveReportDraft({ api, report: original, draft: input.draft, ownerHeaders: () => ({}), fetchImpl })
        : saveReportAssessment({ api, report: original, categories: reviewedCategories(input.categories), severity: input.severity, ownerHeaders: () => ({}), fetchImpl })
      const result = await runConfirmedSave({ save, setSaving: (saving) => controls.push(saving),
        clearFeedback: () => { message = '' }, onError: (error) => { message = error },
        onSaved: (report) => { successes++; input.draft = report.complaint; input.categories = report.categories.join(', '); input.severity = report.severity },
      })
      assert.equal(result, null)
      assert.deepEqual(controls, [true, false])
      assert.deepEqual(input, unsaved)
      assert.equal(successes, 0)
      assert.ok(message.length > 0)
    })
  })
}

test('a successful draft save is shown only after the server confirms the requested text', async () => {
  let completeRequest
  const pendingRequest = new Promise((resolve) => { completeRequest = resolve })
  let saving = false
  let success = false
  let input = '  Resident-reviewed complaint  '
  const promise = runConfirmedSave({ setSaving: (value) => { saving = value },
    save: () => saveReportDraft({ api, report: original, draft: input, ownerHeaders: () => ({}), fetchImpl: () => pendingRequest }),
    onSaved: (report) => { input = report.complaint; success = true }, onError: assert.fail,
  })
  assert.equal(saving, true)
  assert.equal(success, false)
  completeRequest(json({ report: { ...original, complaint: input.trim() } }))
  await promise
  assert.equal(saving, false)
  assert.equal(success, true)
  assert.equal(input, 'Resident-reviewed complaint')
})

test('an HTTP success with mismatched saved draft or assessment is treated as unconfirmed', async () => {
  await assert.rejects(saveReportDraft({ api, report: original, draft: 'New complaint', ownerHeaders: () => ({}),
    fetchImpl: async () => json({ report: { ...original, complaint: 'Old complaint' } }) }), /did not confirm your draft/)
  await assert.rejects(saveReportAssessment({ api, report: original, categories: ['plastic'], severity: 'high', ownerHeaders: () => ({}),
    fetchImpl: async () => json({ report: original }) }), /did not confirm your assessment/)
})

for (const failedAt of ['PUT response', 'confirmation response']) {
  test(`cloud ${failedAt} uncertainty retries confirmation against the same report without another upload`, async () => {
    const tokens = createOwnerTokenStore(() => { throw new Error('Storage blocked') })
    let pendingUpload = null
    let retry = false
    const calls = []
    const fetchImpl = async (url, options) => {
      calls.push({ url, options })
      if (url === `${api}/reports/upload-url`) return json({ report: { ...original, upload_state: 'pending' },
        owner_token: 'private-owner-capability', upload_url: 'https://storage.example/pending/report-one.jpg', upload_content_type: 'image/jpeg' }, 201)
      if (options.method === 'PUT') return failedAt === 'PUT response' ? unavailable() : { ok: true }
      assert.equal(url, `${api}/reports/${original.id}/confirm-upload`)
      assert.equal(options.headers['X-Report-Token'], 'private-owner-capability')
      return retry ? json(original) : unavailable()
    }
    const options = { api, cloud: true, photo, location, preparePhoto: async () => photo, ...tokens,
      fetchImpl, onPending: (pending) => { pendingUpload = pending } }
    await assert.rejects(createReport(options))
    assert.equal(pendingUpload.reportId, original.id)
    retry = true
    const report = await createReport({ ...options, pendingUpload })
    assert.equal(report.id, original.id)
    assert.equal(pendingUpload, null)
    assert.equal(calls.filter((call) => call.url === `${api}/reports/upload-url`).length, 1)
    assert.equal(calls.filter((call) => call.options.method === 'PUT').length, 1)
    assert.equal(calls.filter((call) => call.options.method === 'DELETE').length, 0)
    assert.equal(calls.at(-1).url, `${api}/reports/${original.id}/confirm-upload`)
  })
}

test('an expired or missing upload renews its URL and uploads to the existing report', async () => {
  const tokens = createOwnerTokenStore(() => fakeStorage())
  tokens.rememberOwnerToken(original.id, 'private-owner-capability')
  const pending = { reportId: original.id, uploadUrl: 'https://storage.example/expired', contentType: 'image/jpeg', uploaded: false }
  const calls = []
  let confirmationCount = 0
  const report = await createReport({ api, cloud: true, photo, location, pendingUpload: pending,
    ...tokens, preparePhoto: async () => photo, onPending() {}, fetchImpl: async (url, options) => {
      calls.push({ url, options })
      if (url.endsWith('/confirm-upload')) return ++confirmationCount === 1
        ? json({ detail: 'The photo has not reached private storage yet' }, 409) : json(original)
      if (url.endsWith(`/${original.id}/upload-url`)) return json({ report: { ...original, upload_state: 'pending' },
        upload_url: 'https://storage.example/renewed-pending/report-one.jpg', upload_content_type: 'image/jpeg' })
      if (options.method === 'PUT') return { ok: true }
      assert.fail(`Unexpected request: ${url}`)
    } })
  assert.equal(report.id, original.id)
  assert.deepEqual(calls.map((call) => call.url), [`${api}/reports/${original.id}/confirm-upload`,
    `${api}/reports/${original.id}/upload-url`, 'https://storage.example/renewed-pending/report-one.jpg',
    `${api}/reports/${original.id}/confirm-upload`])
})

test('a pending publication failure never renews, replaces, or deletes the photo', async () => {
  const calls = []
  const pending = { reportId: original.id, uploadUrl: 'https://storage.example/pending', contentType: 'image/jpeg', uploaded: true }
  await assert.rejects(createReport({ api, cloud: true, photo, location, pendingUpload: pending,
    preparePhoto: assert.fail, rememberOwnerToken() {}, ownerHeaders: () => ({}), onPending: assert.fail,
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return json({ detail: 'Your upload is retained. Photo verification could not be completed; retry confirmation for this report.' }, 503)
    } }), /upload is retained/)
  assert.deepEqual(calls.map((call) => call.url), [`${api}/reports/${original.id}/confirm-upload`])
})

test('a malformed cloud creation response retains its issued owner token and report ID for recovery', async (t) => {
  for (const brokenResponse of [
    { report: { id: original.id } },
    { report: { ...original, upload_state: 'pending' } },
  ]) await t.test(Object.hasOwn(brokenResponse.report, 'categories') ? 'missing upload URL' : 'incomplete report', async () => {
    const tokens = createOwnerTokenStore(() => { throw new Error('Storage blocked') })
    let pendingUpload = null
    const calls = []
    const fetchImpl = async (url, options) => {
      calls.push({ url, options })
      if (url === `${api}/reports/upload-url`) return json({ ...brokenResponse, owner_token: 'private-owner-capability' }, 201)
      assert.equal(url, `${api}/reports/${original.id}/confirm-upload`)
      assert.equal(options.headers['X-Report-Token'], 'private-owner-capability')
      return json(original)
    }
    const options = { api, cloud: true, photo, location, preparePhoto: async () => photo, ...tokens,
      fetchImpl, onPending: (pending) => { pendingUpload = pending } }
    await assert.rejects(createReport(options))
    assert.equal(pendingUpload.reportId, original.id)
    assert.equal(tokens.ownerToken(original.id), 'private-owner-capability')
    const recovered = await createReport({ ...options, pendingUpload })
    assert.equal(recovered.id, original.id)
    assert.equal(calls.filter((call) => call.url === `${api}/reports/upload-url`).length, 1)
    assert.equal(calls.filter((call) => call.options.method === 'PUT').length, 0)
  })
})

for (const cloud of [false, true]) test(`${cloud ? 'cloud' : 'local'} lost creation response reuses its client-owned ID and token`, async () => {
  const tokens = createOwnerTokenStore(() => { throw new Error('Storage blocked') })
  let pendingUpload, saved, count = 0
  const attempts = []
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/confirm-upload')) return json(saved)
    if (options.method === 'PUT') return { ok: true }
    const id = cloud ? JSON.parse(options.body).report_id : options.body.get('report_id')
    const token = options.headers['X-Report-Token']
    attempts.push({ id, token })
    saved = { ...original, id }
    if (++count === 1) throw new TypeError('Response lost after persistence')
    return cloud ? json({ report: saved, owner_token: token, upload_url: '', upload_content_type: 'image/jpeg' }, 201)
      : json({ ...saved, owner_token: token }, 201)
  }
  const options = { api, cloud, photo, location, ...tokens, fetchImpl, preparePhoto: async () => photo,
    onPending: (value) => { pendingUpload = value } }
  await assert.rejects(createReport(options))
  assert.ok(pendingUpload.reportId)
  const recovered = await createReport({ ...options, pendingUpload })
  assert.equal(recovered.id, attempts[0].id)
  assert.deepEqual(attempts[1], attempts[0])
  assert.equal(pendingUpload, null)
})

for (const cloud of [false, true]) test(`${cloud ? 'cloud' : 'local'} definite validation rejection unlocks manual location correction`, async () => {
  const tokens = createOwnerTokenStore()
  let pendingUpload
  await assert.rejects(createReport({ api, cloud, photo, location, ...tokens, preparePhoto: async () => photo,
    onPending: (value) => { pendingUpload = value },
    fetchImpl: async () => json({ detail: 'This point is outside the supported pilot. Coordinates unchanged.' }, 422),
  }), /outside/)
  assert.equal(pendingUpload, null)
})

test('reloaded owner report offers retries for interrupted optional steps without another creation', async () => {
  const { storedReportRecovery } = await import('../src/report-workflow.js')
  const report = { ...original, analysis_note: 'AWS region is not configured.', classification: {}, complaint: '' }
  const outcomes = storedReportRecovery(report)
  assert.deepEqual(Object.keys(outcomes), ['analyze', 'classify', 'complaint'])
  assert.match(outcomes.analyze.message, /Report saved.*AWS region/)
  assert.deepEqual(storedReportRecovery({ ...report, is_owner_view: false }), {})
  const calls = []
  await enrichReport({ api, report, steps: ['complaint'], ownerHeaders: () => ({}), fetchImpl: async (url) => {
    calls.push(url); return json({ report: { ...report, complaint: 'Reviewed draft' } })
  } })
  assert.deepEqual(calls, [`${api}/reports/${report.id}/complaint`])
})
