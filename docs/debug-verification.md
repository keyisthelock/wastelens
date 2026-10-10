# Core workflow verification — 2026-10-10

This records the earlier **local debugging pass**, before AWS deployment. The
current cloud status and later checks are in
[AWS integration verification](aws-integration-verification.md).

## Reproduction and fixes

- Baseline local browser creation succeeded. The reported historical failure
  could not be reproduced with a valid synthetic image and pilot coordinates.
- Reproduced `POST /api/reports` HTTP 422 with coordinates outside the configured
  pilot rectangle. Error: “This location is outside the supported Lucknow pilot
  area. Your coordinates were not changed…” The form retains input and enables
  correction; correcting the synthetic point produced a ready report.
- Lost creation responses previously had no reusable initial creation ID.
  Clients now keep a private UUID/token pair before calling either creation
  endpoint, and the server recognizes owner-authorized replays. Cloud upload
  confirmation retains its existing pending/final lifecycle checks.
- Device requests previously accepted a cached low-accuracy fix and dropped
  accuracy. Requests now use high accuracy and maximumAge 0, return the provider
  accuracy, and display it. Browser errors never generate substitute coordinates.
  Generic Lucknow coordinates are only initial map views, not device readings.
- Runtime `/api/ai/status` reports region_configured=false and ready=false.
  Bedrock and Rekognition cannot run without configuration. No live AWS model
  access or IAM permission was verified. Mocked service checks cover validated
  output, partial/truncated output, material parents, moderation failure, uploads,
  and storage transitions.
- Normalization previously permitted 4,800,000 bytes, above Bedrock Converse’s
  documented 3.75 MB image ceiling. Both frontend and backend now cap JPEGs at
  3,700,000 bytes. Rekognition no longer assigns plastic/metal/glass from ambiguous
  bottle/can/jar labels alone. Failed moderation preserves successful labels;
  failed AI preserves resident edits. Responses identify their source.

## Checks actually run

- Backend: `.venv/bin/python -m unittest discover -s tests -q` from backend.
- Frontend: `npm test`; `npm run build` from frontend.
- Backend suite: 56 passed. Frontend suite: 51 passed. Production build passed.
  An initial backend run from repository root lacked the app import path; rerun
  from backend passed. One assertion expected the old pilot error wording and
  was updated to assert the clearer rejection.
- Browser-created report: `4971640b-bfeb-46f8-b442-eda4de54b897`.
  Confirmed in SQLite, public GET HTTP 200, owner photo/details available, and
  report permalink restores the owner view after reload via session token.
- Full live local API flow: `53df99a3-8c9f-4873-898f-4619f365c850`.
  Creation and repeat: 201, same ID. Analyze/classify: 200 with unavailable
  source. Draft: 200, sent=false. Owner GET: 200, draft 468 characters. SQLite
  row ready. CORS preflight: 200, origin http://127.0.0.1:5173 allowed.
- Live Overpass lookup: HTTP 200, zero mapped results within 500 m of the public
  test point 26.8467, 80.9462. Not evidence of zero physical bins or coverage at
  the resident’s actual location. Tests separately exercise radius, private
  access, invalid coordinates, recycling-container filtering and outside-pilot
  rejection without any external lookup.
- These are clearly marked synthetic local test reports, not real waste
  sightings. No municipal email or infrastructure deployment occurred.

## Limitations

- No successful live AWS inference or S3/DynamoDB deployment was verified.
- Browser/provider location accuracy depends on device capabilities and
  permissions. The resident’s device location was not collected during testing.
- The Lucknow rectangle remains an approximate pilot guard; it does not verify
  municipal wards or guarantee coverage of every Sarojini Nagar site.
- The dev browser disconnected/reloaded immediately after creation in two runs;
  its Vite logs show reconnection, which interrupted optional enrichment in the
  browser. Persistence, permalink recovery and the complete API enrichment flow
  were verified independently. Reopened reports now restore retry controls, and
  retrying complaint drafting in the browser populated the existing report. Backend dev-server logs belong to earlier pipe
  sessions and were not available; no backend traceback was observed for the
  reproduced validation rejection.

## Files changed in this debugging pass

Backend: `backend/app/routes.py`, `backend/app/services.py`,
`backend/app/image_security.py`.
Frontend: `frontend/src/App.jsx`, `frontend/src/location.js`,
`frontend/src/report-workflow.js`.
Regression tests: `backend/tests/test_api.py`,
`backend/tests/test_cloud_upload.py`, `frontend/tests/location.test.js`,
`frontend/tests/report-workflow.test.js`.
Documentation: `docs/api-contract.md`, `docs/debug-verification.md`.
Other uncommitted work present before this pass was preserved.
