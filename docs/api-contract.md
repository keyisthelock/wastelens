# WasteLens API contract

Base path: `/api`. JSON responses use snake_case. The authoritative machine-readable contract is the FastAPI OpenAPI document at `/openapi.json`.

| Method and path | Request | Purpose |
| --- | --- | --- |
| `POST /reports` | multipart: `photo`, `latitude`, `longitude`, optional `address` | Create a report and store its photo |
| `POST /reports/upload-url` | `{ "latitude": 26.8467, "longitude": 80.9462, "address": "..." }` | Reserve a private pending cloud report, issue its owner token once, and sign a five-minute PUT for `pending/{id}.jpg` |
| `POST /reports/{id}/upload-url` | `X-Report-Token` | Renew a PUT for the same pending report; returns `{report}` without a PUT URL when already ready |
| `POST /reports/{id}/confirm-upload` | `X-Report-Token` | Validate and normalize the pending JPEG, store the final photo, atomically persist its final key and ready state, then clean up only the pending object |
| `GET /reports` | optional `status`, `limit` | List community reports |
| `GET /reports/{id}` | — | Fetch a report |
| `POST /reports/{id}/analyze` | `{}` or `{ "categories": ["plastic"], "severity": "medium" }` | Analyze with Rekognition if configured; optional resident-entered values save a manual review |
| `POST /reports/{id}/complaint` | `{}` or `{ "draft": "edited text" }` | Draft or save an edited complaint; does not send it |
| `GET /submission/status` | — | Report whether SES sending is configured and return the verified pilot recipient |
| `POST /reports/{id}/submit` | `{ "draft": "approved text", "confirmed": true, "jurisdiction_confirmed": true }` plus `X-Report-Token` | Send only after explicit owner approval and location confirmation; recipient is fixed from the verified directory |
| `POST /reports/{id}/support` | `{}` | Add one support per client token |
| `PATCH /reports/{id}/status` | `{ "status": "reviewed" }` | Update community status; no municipal status is implied |
| `GET /authorities` | optional `city` | List verified directory entries for a configured pilot city; unknown cities return no match |
| `POST /waste/guide` | multipart: `photo` | Return a Bedrock visual waste suggestion and source-backed recovery route when configured; image is not saved to WasteLens report/photo storage; manual choice remains available in UI |
| `POST /nearby-bins` | `{ "latitude": 26.8467, "longitude": 80.9462, "radius_meters": 1500 }` | Query OpenStreetMap/Overpass for pedestrian litter bins and recycling containers in the approximate Lucknow pilot extent; radius is limited to 100–3,000 metres and coordinates are not stored |
| `GET /ai/status` | — | Report whether Strands and a Bedrock region are configured |
| `POST /assistant` | `{ "message": "...", "report_id": "optional" }` | Ask the field guide about the board, verified authority channels, or possible nearby duplicates |

Statuses are `community_reported`, `reviewed`, and `cleanup_confirmed`. `cleanup_confirmed` is a community-recorded status, not a municipal verification. The Lucknow entry is based on Lucknow Nagar Nigam's official helpline page. It is a city-level candidate; the app does not check exact municipal boundaries from coordinates. Unknown or unconfigured authority coverage is returned as such rather than guessed. The directory’s `nnlko@nic.in` address is a published public contact, not a documented complaint ticket inbox. SES acceptance is labelled as an email sent for delivery; LNN receipt, acknowledgment, and ticket creation are not guaranteed. A separate final button plus two explicit confirmations are required for every first send or retry. Delivery-unknown results are locked against duplicate sends.

The assistant response includes `mode`, `ai_used`, and `ai_status`. If Bedrock is not configured or a request fails, it uses local intent matching. With Bedrock, Strands classifies the question into one exact allowlisted intent. The model has no tools or report context, and its free-form output is never shown to residents. WasteLens composes visible answers locally from the verified authority directory and SQLite data; proximity checks are calculated locally. Photos, exact coordinates, and report summaries are not passed to Bedrock. A proximity match is only a suggestion, not a confirmed duplicate.

`POST /reports` stores a WasteLens community report. `POST /reports/{id}/submit` emails the owner-approved draft and exact reported location to the fixed Lucknow directory recipient only when SES is configured and the owner provides both confirmations. It does not change the report’s civic status or claim that a municipal ticket exists.

Cloud report photos follow `pending/{id}.jpg` → validation/normalization → `reports/{id}.jpg`. Pending reports are excluded from the board and public detail reads; even the owner receives no photo URL until readiness is committed. Normal photo reads and assessment/classification endpoints retain their ready-state guard. Confirmation requires the owner token, and repeating it for a ready report does not read or rewrite the image. Final-object writes are conditional: the first validated snapshot is immutable, so overlapping retries cannot overwrite a published photo. An existing final object must pass report metadata, size, digest (when present) and image validation before a pending record can be published. Failed storage or state writes preserve the pending object for retry; a lost state-write response can be recovered with another confirmation. Pending cleanup is best effort after publication and never targets the final object. Pending records created by older code with an incorrect final-key reference can still confirm the canonical pending key. If a PUT failed or expired, renew its URL against the existing report ID rather than create another report.

After report creation and photo confirmation, optional analysis, classification, complaint drafting and board synchronization are independent recovery steps. The frontend retains the created report and retries failed enrichment against that ID. A board-refresh failure does not change whether a report or an edit was saved.

`POST /waste/guide` normalizes an uploaded image for the requested classifier call but does not create a report or save the image in WasteLens photo storage. If Bedrock is unavailable, its response marks analysis unavailable and the UI offers the local recovery directory for manual category selection. Classification and rough mass are suggestions, not verified facts.

`POST /nearby-bins` rejects coordinates outside the approximate pilot extent before making an external request. For an allowed point it sends one bounded Overpass query for pedestrian litter bins and recycling containers with a 100–3,000 m radius, sorts up to 30 mapped results by distance, and does not persist the coordinates. It omits `amenity=waste_disposal`: OpenStreetMap describes that tag for medium or large bagged-waste bins that are not primarily for passers-by ([waste disposal tag](https://wiki.openstreetmap.org/wiki/Tag%3Aamenity%3Dwaste_disposal)). The included tags distinguish pedestrian litter bins and recycling containers ([waste basket](https://wiki.openstreetmap.org/wiki/Tag%3Aamenity%3Dwaste_basket), [recycling container](https://wiki.openstreetmap.org/wiki/Tag%3Arecycling_type%3Dcontainer)). Nearby results are contributed map data, not verified locations or a guarantee that an object is public, accessible, operational, or accepts a given material. The UI asks for browser location only after the user chooses the lookup and discloses the Overpass query. Requests are limited to four per minute per client; the public service is intended for low-volume queries ([Overpass API usage guidance](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances)).

### Recovering a lost creation response

Clients may send a UUID `report_id` with `POST /reports` (multipart form) or
`POST /reports/upload-url` (JSON), together with a randomly generated private
`X-Report-Token` of 32–128 characters. Keep the same ID, token, and location for
retries. The first successful insert owns that ID; subsequent owner-authorized
retries return the persisted report. A token mismatch is rejected; changed
location/address returns 409. Only hashed tokens are stored. Clients that omit
`report_id` continue to receive a server-generated ID and token.

Cloud retries return the existing pending upload URL or the already-ready
report; a ready report does not need another PUT. Validation rejections (400,
413, 415, 422) let users correct their form. A lost response is an unconfirmed
attempt, not proof of either failure or successful persistence.

Analysis responses identify `source` as `aws_rekognition`, `aws_bedrock`,
`resident_reviewed`, or `unavailable`. Unavailable analysis does not erase a
saved resident assessment. Normalized photos are capped at 3,700,000 bytes so
both image providers can accept them. Device geolocation remains a browser
operation; its accuracy is displayed and its coordinates are never replaced by
the pilot map center. The pilot boundary guard applies separately to bin
lookups and report creation.

### Community photos and discussion

- Creation accepts `photo_public` (boolean, default false). Existing records
  default to false; no previous private photo is automatically published.
- `PATCH /reports/{id}/photo-sharing`: owner token required; JSON
  `{"photo_public": true|false}`; returns the updated owner report.
- `GET /reports/{id}/photo`: a ready, shared photo can be read publicly.
  A private photo requires its owner token. Responses are no-store and never
  expose the storage key. Public report payloads use this API URL for shared
  photos; precise locations and complaint drafts remain private.
- `GET /reports/{id}/comments`: public, ready reports only; returns the most
  recent 100 comments in chronological order. Optional X-Client-Token marks
  messages belonging to this browser. Tokens and hashes are never returned.
- `POST /reports/{id}/comments`: X-Client-Token required (16–128 characters).
  JSON `{"id":"client-generated UUID","author":"alias","body":"message"}`.
  Author is 1–40 characters; body 1–1200. A retry uses the same UUID and identical
  text. These aliases are unverified, not authenticated identities.
- `DELETE /reports/{id}/comments/{comment_id}`: author participation token or
  report-owner token required. Enables author removal and reporter moderation.
- `GET /reports/{id}/solutions`: local coordination steps, available sourced
  material route, `source: local_guide`, `ai_used: false`. It does not schedule
  cleanups or claim a live AI generation. The assistant also accepts the bounded
  `solutions` intent using optional Bedrock routing and a labelled local fallback.

## Resident community directory (Lucknow pilot)

- `GET /api/communities` → `{ communities: [...], city: "Lucknow", limit: 50 }`.
  Public fields: `id`, `name`, `area`, `description`, `creator`, `city`, `created_at`.
- `POST /api/communities` requires `X-Client-Token` (16–128 characters).
  Body: `{ id: UUID, name, area, description, creator }`; returns 201
  `{ community: ... }` only after persistence. Same UUID/token/details is safe to retry;
  conflicting details return 409 and another browser's token returns 403.
- Directory entries are resident-created and unverified. No account membership,
  municipal affiliation or cleanup approval is implied. Participation token hashes
  are private; all entered community details are public.

## Pilot accounts

Guest reporting remains available. Account login does not transfer guest report
ownership across devices.

- `POST /api/auth/register`: `{name,email,password}`; 201 `{user}` after persistence.
  Password 12–128 characters; duplicate email 409; email verification unavailable.
- `POST /api/auth/login`: `{email,password}`; 200 `{user}` after verification and
  session creation; wrong/unknown credentials share a generic 401.
- `GET /api/auth/me`: `{user}` or `{user:null}` for anonymous/expired sessions.
- `POST /api/auth/logout`: revokes this browser's session, clears cookie, returns
  `{signed_out:true}` only after completion.
- Password-account response: `id,name,email,email_verified:false,auth_provider:password`;
  no hashes, salt or token.
- Opaque 24-hour sessions: HttpOnly, SameSite=Strict; Secure in cloud/HTTPS.
  Only session hashes stored; auth responses `Cache-Control:no-store`.
- Salted scrypt passwords (`N=32768,r=8,p=3`); browser-origin checks and per-process
  auth rate limits. Credentialed CORS requires the exact configured origin.
- DynamoDB account/session rows have no public report/community index keys.
- Email recovery, verified identity, account deletion, distributed auth abuse
  prevention, and automatic expiry cleanup remain work before a broader rollout.

### Optional Google sign-in

- `GET /api/auth/google/config`: `{configured,client_id}`. Returns only the public
  Web client ID; unset/invalid configuration disables Google sign-in.
- `POST /api/auth/google/challenge`: `{}`; returns `{nonce,expires_in:600}` and a
  private HttpOnly challenge cookie. Requires an allowed browser origin.
- `POST /api/auth/google`: `{credential: GOOGLE_ID_TOKEN}` plus that cookie;
  verifies the signature, issuer, audience, expiration, verified email and nonce,
  then atomically consumes the challenge and creates the existing account session.
  Missing/replayed/expired/mismatched challenges or invalid tokens return 401;
  unconfigured Google or unavailable key verification returns 503.
- Google users return `auth_provider: "google", email_verified: true`; password
  users return `auth_provider: "password", email_verified: false`. No Google token
  or subject is returned. Validation errors never echo submitted auth credentials.
- Google identity uses its stable subject and remains separate from same-email
  password profiles. No implicit account linking or guest report transfer.
- See [setup and deployment](google-signin.md). Real Google sign-in is not yet
  verified; the account's OAuth client ID is still required.

Camera photos are JPEGs passed through the same report/guide endpoints as uploaded
files. Capture does not create a report until the resident submits the form.
