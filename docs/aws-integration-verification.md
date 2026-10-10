# AWS integration verification — 2026-10-10

## Bedrock retry and guide wording update

A fresh, single Nova Lite text request in Sydney used `maxTokens=8` and disabled
SDK retries. It returned HTTP 429 / `ThrottlingException` with the message
“Too many tokens per day, please wait before trying again.” No resident data or
image was sent. Temporary non-root identity was verified before the call.

`GetFoundationModelAvailability` returned `AUTHORIZED` and `AVAILABLE` for model
agreement, entitlement and region. The model metadata includes `ON_DEMAND` and
`INFERENCE_PROFILE`, with text/image/video input support. Applied quotas were:

| Quota | Code | Value | Adjustable via Service Quotas |
| --- | --- | --- | --- |
| Daily model invocation tokens | L-45E0AD92 | 0 | No |
| On-demand requests per minute | L-E386A278 | 0 | No |
| On-demand tokens per minute | L-70423BF8 | 0 | No |
| Cross-region requests per minute | L-89F8391A | 0 | No |
| Cross-region tokens per minute | L-7C42E72A | 0 | Yes |

The retry confirms an account inference allowance blocker; model availability
alone is not proof of usable runtime access. Changing prompts or broadening IAM
does not resolve a zero daily-token allowance. No quota change, model/region
switch, provisioned throughput, plan upgrade or AWS Support message was made.
AWS documents that applied quotas can be lower than published defaults:
[Bedrock quotas](https://docs.aws.amazon.com/bedrock/latest/userguide/quotas.html).

The frontend now uses **Lucknow community guide**, with **Local pilot guidance**
on sourced replies. A live contact question returned that label and the verified
LNN information. The footer describes sources rather than deployment diagnostics.
The production build passed, the frontend was published to the existing S3 bucket,
and CloudFront's entry page was invalidated. Backend mode flags remain truthful.

## Camera / optional Google update (published)

The report form and personal guide now have an explicit camera capture, review,
retake and accept flow. The image uses the existing upload endpoints; no new AWS
service was added. Local and live browser inspection confirmed the controls and
layout. Production build, Python compilation, SAM lint, ARM64 package build and
whitespace checks passed. The existing stack update completed; frontend assets
were uploaded and CloudFront's entry page invalidated. Live entry/API requests
returned 200, retained the existing synthetic report, confirmed anonymous session
behavior and returned Google `configured:false`. The entry page serves the new
bundle and the camera/microphone permissions and popup headers. A first local
urllib HTTPS check encountered missing local CA roots; checks succeeded using
HTTPX's trusted certificate bundle without disabling TLS verification.
Physical-device capture has not been verified in this pass.

Google sign-in is prepared behind an empty `WASTELENS_GOOGLE_CLIENT_ID` / SAM
`GoogleClientId` setting. The user deferred Google configuration to future
development; it remains disabled. No real Google authentication is claimed.
The existing 97 backend / 55 frontend test results below precede this update;
the suites were not rerun for this feature pass. The live site below now includes
the camera controls and disabled Google sign-in preparation.

## Live deployment

The approved Sydney (`ap-southeast-2`) pilot is deployed:

- Website: https://d29b1yfg6ycbnb.cloudfront.net/
- API: https://ptmuyheuy5.execute-api.ap-southeast-2.amazonaws.com/prod
- Stack: `wastelens-pilot`.
- Temporary non-root project role verified through STS. No permanent access keys,
  AdministratorAccess policy or free-plan upgrade was created.

| Service | Actual verification | Result / limitation |
| --- | --- | --- |
| Lambda / API Gateway / CloudFront | Deployed runtime, HTTPS page and API requests | Working; health, authority directory, reports, guidance and assistant return 200 |
| S3 | Real signed PUT, normalized final photo, owner GET, pending cleanup | Working; private buckets, exact-origin PUT CORS and regional SigV4 URLs verified |
| DynamoDB | Independent strong read of saved report, discussion/support/status writes | Working; ready report and final photo reference persisted |
| Rekognition | Real DetectLabels and DetectModerationLabels; deployed analysis and guide calls | Working on consented synthetic image; no claim of accuracy on real waste photographs |
| Bedrock Nova Lite | Model metadata and real image/text Converse attempts | NOT working: ThrottlingException; Sydney inference quotas read as zero |
| Ask WasteLens AWS planner | Validated multi-topic Strands/Bedrock integration, mocked success and failure tests | Implemented; live chat uses labelled local guidance while Bedrock is disabled |
| Secrets Manager | Operator token retrieved only in process memory for synthetic status checks | Working; no secret printed or committed |
| SES | Sender left empty; email disabled | No real municipal email sent; delivery not verified |

## Cloud reporting check

Synthetic, non-sensitive image clearly marked **not a real waste sighting**:

- Created report `0bf214dc-092e-48fd-83d9-06b8b28613f6`; repeated creation retained that ID.
- Pending report hidden from anonymous reads. Signed pending PUT returned 200.
- Confirmation returned 200 twice; final JPEG stored at `reports/{id}.jpg`.
- Independent DynamoDB read confirmed `upload_state=ready` and final reference.
- Final S3 object present; pending object absent after cleanup.
- Private photo denied anonymous access and allowed owner access.
- Owner opt-in sharing allowed anonymous photo access; revocation restored privacy.
- Real Rekognition analysis completed; manual assessment saved a synthetic-test label.
- Complaint draft saved with `sent=false`; no email operation used.
- Duplicate comment UUID produced one discussion entry; repeated support counted once.
- Public responses omitted owner capability, address and complaint draft.
- Operator status changes persisted two events; unauthorized status change returned 401.
- Report retrieved through API and CloudFront after deployment updates.

This is a synthetic infrastructure test, not evidence of municipal action or cleanup.
The local SQLite database and private local resident photographs were not migrated.
A browser-based file-picker attempt was blocked by the automation bridge; the full
cloud upload workflow above was exercised through real HTTP requests instead.
Device GPS and real resident waste-classification accuracy were not verified here.

## Repairs found in live deployment

1. API Gateway's `/prod` stage reached FastAPI unstripped and caused health 404.
   Mangum now explicitly uses the configured stage base path; regression test passes.
2. Fresh bucket upload URLs used the global S3 endpoint and returned 307.
   All S3 clients now use explicit regional endpoints and SigV4; real PUT/GET passes.
3. Default SAM source copying included local DB/photos. Replaced with a source
   allowlist plus ARM64 Linux wheels; inspected package excludes credentials,
   environment files, uploads, local databases, tests and virtual environments.
   Unsafe initial temporary artifact removed before deployment.

## Ask WasteLens

AWS selects one to three validated help topics in response to the resident's question.
WasteLens composes verified contacts, board counts, reporting instructions and safe
community action guidance locally. Invalid topic IDs, extra fields and model prose
are rejected. No tools allow the model to send complaints or change reports.
Report IDs, private coordinates, drafts, photos and discussions are not included in
model prompts; residents should avoid putting personal information in chat questions.
The configured Nova Lite model has a bounded response size and shared daily allowance.

Bedrock is currently disabled because real requests returned HTTP 429. Rekognition
is not a text chatbot substitute. The UI uses the header **Lucknow community guide** and labels sourced fallback
responses **Local pilot guidance**. Provider failures remain recorded in API
status and this verification document; the UI does not claim live AWS chat. Set `BedrockEnabled=true` only after account inference
allowance is available, then verify a real chat request. A text-only readiness probe
cannot verify image classification, storage or report creation.

## Checks run

- Backend unittest: **97 passed**, including AWS multi-topic plan validation,
  unsupported output, failure fallback, natural greetings with no AWS calls, disabled model, upload lifecycle, filtering,
  Lambda stage path, daily allowance and packaging cases.
- Frontend: **55 tests passed**; Vite production build passed.
- SAM ARM64 build and lint validation passed in this deployment pass.
- Exact-origin API and S3 upload preflight requests passed live.
- Updated live chatbot returned 200 for hello, how-are-you, thanks and cleanup guidance;
  browser verification confirmed the friendly greeting and quick-reply label. Existing
  synthetic report remained retrievable after the chatbot deployment update.
- CloudFront TLS, security headers, both S3 public-access blocks and DynamoDB
  encryption checked live.
- Mocked AWS tests establish code behavior; they do not establish Bedrock access.

## Budget and remaining limitations

Deployment/test spending target is under $5, not a guaranteed billing cap.
Daily app allowance is 25 logical AI operations, atomically checked in DynamoDB;
SDK retries, moderation calls, unrelated account usage and infrastructure charges
are outside that counter. Last checked app counter was 2 operations before the
additional small operator text verification. No repeated AI jobs or always-on compute
were provisioned. AWS Free Tier API reported FREE/ACTIVE and $120 remaining credits
at the account check; billed usage may lag and is not claimed to be zero.

Read-only alternative-model quota checks also found zero Sydney allowance for Nova Micro, Titan Text Express and the checked Llama 3.2 variants. No alternative model was invoked or service provisioned. Bedrock allowance and SES delivery remain demo blockers. Community membership and
moderation are limited; local rate limits are per process. Abandoned pending reports
have no DynamoDB expiry; pending S3 objects have a two-day lifecycle. Overpass bin
coverage can be incomplete and is not a verified municipal bin inventory.

## Community directory update

Added a report-card Comment action that opens and focuses the existing saved
discussion box. Added a resident-created Lucknow community directory beside the
map (below it on smaller screens), with public name, area, purpose and alias.
Creation uses UUID retries and browser participation-token ownership; DynamoDB
community entries use a separate directory partition, not the report board.
SQLite receives an additive communities table. Regression tests cover durable
creation, repeated requests, validation, conflicting ownership and private hashes.
This directory does not yet implement member accounts or group-specific chat.

Live directory verification: synthetic community `57b17d0a-7323-46bb-ba2d-8b83fe2b76c9`
created with 201, repeated with the same ID, unauthorized request rejected with 401,
and independent DynamoDB read confirmed the directory partition. The live browser
showed the community entry and creation form. Report-card Comment opened and focused
the textarea; a clearly labelled test message was saved and retrieved publicly.

## Social frontend and account update

Implemented neighborhood navigation, a feed composer and social report cards,
a dedicated `#groups` registration hub, and `#login` with real email/password
registration, login, session restore and logout. Guest reporting remains open.
Local tests: 97 backend / 55 frontend passed; production build and SAM lint passed.
An isolated local HTTP check verified registration, hashed password persistence,
cookie sessions, logout revocation and login again without printing credentials.
Browser checks verified phone layout (390 px, no horizontal document overflow),
community registration and persistence after refresh, and guest report-form access.
This update was published to the existing Sydney stack after STS verified the expected non-root project role. Live CloudFront HTTP checks verified registration, Secure/HttpOnly/SameSite cookies, session restore, password rejection, logout and new login. An independent DynamoDB read confirmed a salted password hash and no public index keys. Browser checks confirmed the published login and dedicated community registration pages. Existing reports and communities remained accessible.
Email verification/recovery, account deletion and distributed auth abuse controls
are not configured; guest report ownership is still a browser capability.
