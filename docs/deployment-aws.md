# AWS deployment

The Lucknow pilot is deployed in Sydney (`ap-southeast-2`) at
https://d29b1yfg6ycbnb.cloudfront.net/. This guide also explains how to reproduce the
deployment. See [live verification](aws-integration-verification.md) for what was
checked. Bedrock and SES remain disabled; storage, hosting and Rekognition are live.

## Requirements

- AWS CLI authenticated through an approved profile or IAM Identity Center.
- AWS SAM CLI, Python 3.13, and Node.js 22. Docker is optional for a container build;
  the current deployment uses the allowlisted Makefile with ARM64 Linux wheels.
- Permission to create CloudFormation, Lambda, API Gateway, CloudFront, S3, DynamoDB, Secrets Manager, CloudWatch, Bedrock, and Rekognition resources.
- Bedrock model access enabled for the model you pass to SAM.
- Optional: an Amazon SES verified sender identity and production sending access if complaint email submission is to be enabled. SES sandbox accounts generally cannot email an unverified LNN destination.

Do not place long-lived credentials in `.env`, shell history, GitHub, or the browser. The SAM stack creates a random operator token in Secrets Manager.

## Deploy

1. Build the frontend and SAM package:

   ```sh
   cd frontend
   npm ci
   npm run build
   cd ..
   sam build --use-container
   ```

2. Deploy the stack once with a temporary, exact HTTPS origin to create CloudFront:

   ```sh
   sam deploy --guided --parameter-overrides AllowedOrigin=https://example.org
   ```

   Choose a stack name and region. To enable complaint email, also provide `ComplaintEmailFrom=your-verified-sender@example.org`; otherwise leave the optional parameter empty. The initial frontend is private and will not upload photos from its CloudFront address until the origin is updated.

3. Read the `WasteLensSiteUrl` and bucket outputs, then update the stack’s CORS origin to that exact URL (without a trailing slash):

   ```sh
   sam deploy --parameter-overrides AllowedOrigin=https://YOUR_DISTRIBUTION.cloudfront.net
   ```

4. Publish the built static frontend and invalidate the distribution cache:

   ```sh
   aws s3 sync frontend/dist s3://YOUR_FRONTEND_BUCKET --exclude index.html --cache-control 'public,max-age=31536000,immutable'
   aws s3 cp frontend/dist/index.html s3://YOUR_FRONTEND_BUCKET/index.html --cache-control no-cache --content-type text/html
   aws cloudfront create-invalidation --distribution-id YOUR_DISTRIBUTION_ID --paths / /index.html
   ```

5. Open the CloudFront URL and check `/health`, `/api/security/status`, and `/api/ai/status`. Create a test report and verify its private S3 object, rounded public location, owner-only photo, and delete path. Verify actual Bedrock and Rekognition access with a real test request before showing either as active.

6. Keep the operator token off the frontend. Retrieve it only into a trusted operator environment when changing a report status:

   ```sh
   aws secretsmanager get-secret-value --secret-id YOUR_OPERATOR_SECRET_ARN --query SecretString --output text
   ```

   Use that value in the `X-Admin-Token` header. Do not place it in React environment variables or share it with residents.

## What the template creates

- CloudFront-served frontend with HTTPS, browser security response headers, and API forwarding.
- HTTP API with request throttling and exact-origin CORS.
- Lambda + FastAPI/Mangum modular monolith.
- S3 private uploads with Block Public Access, server-side encryption, TLS-only access, a short pending-upload lifecycle, and origin-restricted browser PUTs.
- DynamoDB reports with KMS encryption, a locality index, and point-in-time recovery.
- A randomly generated operator secret, scoped service permissions, and a 14-day API log group.
- Optional, least-privilege `ses:SendEmail` for the configured verified sender identity. The recipient remains fixed to the verified Lucknow directory contact. Leave `ComplaintEmailFrom` empty to keep sending disabled.

Email submission is not enabled merely by deploying the stack. Verify the configured sender identity in the same AWS account and region, request SES production access (the public LNN address is not a sandbox-verified recipient), and confirm the Lambda role’s conditional SES permission. The app sends no email until a report owner edits/reviews the draft, confirms the precise location and jurisdiction, and presses the final send button. SES acceptance means accepted for delivery only; it does not prove inbox receipt, acknowledgment, or ticket creation. Unknown delivery outcomes are not automatically retried to avoid duplicates.

CloudFormation success confirms resources were created; it does not prove the model is enabled, every organization policy is compatible, or the application behaves correctly. Review the deployed stack and run the flow above.

## Verify access before deployment

Use a temporary **non-root** identity (IAM Identity Center or AWS CLI v2 browser
login). Never share passwords or generate permanent keys for this project.
`aws login --profile wastelens` uses a browser and requires an eligible non-root
identity; `aws logout --profile wastelens` signs the local session out. Follow
[AWS's browser login instructions](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html).
The installed boto3 credential provider must support the chosen sign-in method.
Set `AWS_PROFILE` and `AWS_REGION` in the backend's process environment, then
restart the backend. `.env.example` is documentation: it does not configure the
already-running server automatically.

Run the operator audit from the repository root:

```sh
backend/.venv/bin/python backend/scripts/aws_readiness.py --profile wastelens --region YOUR_REGION
```

Default checks are metadata reads: STS identity, Bedrock model/profile details,
S3 public access block and DynamoDB table status. Missing configuration is reported
as unavailable. The audit refuses root identities and static credentials. A read
success does not prove upload, persistence or inference permissions. Additional
operator read permissions are `bedrock:GetFoundationModel` or
`bedrock:GetInferenceProfile`, `s3:GetBucketPublicAccessBlock`, and
`dynamodb:DescribeTable`; these are not required in the application's runtime role.

Only after approving a non-sensitive test image and inference charges:

```sh
backend/.venv/bin/python backend/scripts/aws_readiness.py --profile wastelens --region YOUR_REGION --photo /absolute/path/to/consented-test.jpg --allow-inference
```

This invokes Rekognition DetectLabels/DetectModerationLabels and Bedrock Converse,
normalizes the photo, returns real results or errors, and creates no report, stack
or email. Do not upload a resident's private photo as an operator test without
consent. `/api/ai/status` uses a cached **text-only** Bedrock probe; it is not proof
of multimodal analysis, Rekognition or storage readiness, and can incur a small
inference charge when credentials and region exist.

### Model and IAM selection

The generic SAM default is Claude Sonnet 4.5. The deployed pilot explicitly uses
`amazon.nova-lite-v1:0`, `prompt_json`, and `BedrockEnabled=false`. A bare model ID
may not be invocable on demand in every region. Verify the actual model or profile
with metadata and then inference. Cross-region routing can process data outside
the selected region; review that before choosing a profile.

Consider **Amazon Nova Lite** as a lower-cost multimodal alternative, subject to
region availability and an actual quality test. Its current model card supports
image Converse input but does **not** support native structured outputs. To choose
it explicitly, set `WASTELENS_BEDROCK_MODEL_ID` to a supported Nova Lite model/profile
ID and `WASTELENS_BEDROCK_OUTPUT_MODE=prompt_json`. The response still undergoes
local Pydantic validation; invalid JSON is unavailable, never fabricated success.
No automatic model switching occurs.

Sources: [Nova Lite capabilities and regions](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-lite.html),
[structured output support](https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html),
[current pricing](https://aws.amazon.com/bedrock/pricing/).

For a direct model, SAM's default permission scopes InvokeModel to the selected
regional foundation model. For an inference profile, supply
`BedrockInvokeResourceArns` with the **exact profile ARN and the required destination
foundation-model ARNs**, and select `BedrockOutputMode` explicitly. Do not use a
service-wide wildcard. See [AWS inference-profile IAM requirements](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html).
The new AllowedOrigin constraint requires an exact HTTPS origin.

### Remaining production checks

SAM validation/build are packaging checks, not live deployment verification.
Verify storage writes, confirmation, reboot persistence, CORS and HTTPS against the
approved deployed API. Review Bedrock's first-use schema compilation latency,
API Gateway time limits, per-process rate limiting on Lambda, billing alerts and
trial-credit eligibility. Concurrent Lambda instances do not share in-memory rate
limits. Abandoned S3 pending objects expire after two days; pending DynamoDB rows
currently have no automatic expiry. Community membership and community-submitted
map points are **not implemented**. Nearby bins are sourced from Overpass.

Photos remain in a private S3 bucket. Explicit photo sharing authorizes the app's
public photo endpoint; it does not make the bucket public. SES remains optional
and must not be invoked as a smoke test.

## Tools installed on this development Mac (2026-10-10)

- AWS CLI v2: `$HOME/.local/bin/aws` (user-only installation).
- SAM CLI 1.168.0: `/private/tmp/wastelens-sam-tools/bin/sam` (temporary environment;
  reinstall if that directory is cleaned).
- boto3 AWS CRT extra installed in `backend/.venv` for temporary browser credentials.
  Recreating that venv requires `backend/.venv/bin/python -m pip install 'boto3[crt]==1.43.110'`.
- macOS developer signature/notarization of the official CLI installer verified.
- Backend `pip check` passed after installation. No AWS profile, region or account
  authentication was established by installing these tools.

Use the full AWS CLI path above, or add `$HOME/.local/bin` to PATH in your own shell.
Console browser login and CLI temporary authentication are separate steps; signing
into the console alone does not configure the backend credential chain. Do not
use the root account for the project integration. CLI browser login may require
`SignInLocalDevelopmentAccess` on the non-root identity. Any account permission
changes require a separately reviewed approval.

## New AWS project experience

The actual account used for this pilot is the newer AWS project experience. Its
assigned project region is Sydney, `ap-southeast-2`; the owner approved this region
and temporary access via the existing managed AccountFullAccessRole. This is a
non-root assumed role, verified with STS. IAM console users are not the supported
human sign-in path for this account type. The earlier Mumbai IAM template remains
a proposal for advanced AWS accounts and was not used to connect this project.

The deployment uses the named profile `wastelens`, temporary browser authentication,
no permanent access keys, and no AdministratorAccess policy attachment. Runtime
Lambda permissions are scoped by SAM to the project's table, buckets, secret and
selected model. Deployment-role access is broader than runtime access; do not reuse
it as the app's identity. AWS project access is documented at
https://docs.aws.amazon.com/accounts/latest/reference/connect-ai-coding-tool.html.

### Demo cost controls

- `AiDailyLimit=25`: DynamoDB conditional counter shared across Lambda instances,
  reset by UTC date. Counts logical app operations, including failures/probes;
  SDK retries and Rekognition moderation may make additional physical requests.
- If the counter cannot be updated, AI fails closed while reporting/manual editing
  remain available. Counter rows have no board index and do not appear as reports.
- No EC2, load balancer, NAT gateway, provisioned model throughput, paid-plan upgrade,
  periodic AI jobs, or SES sender configured.
- This is an inference-operation limit, **not a dollar spending cap**. Other API,
  storage, logging and network usage still accrue costs/consume credits. Billing data
  can lag. The initial deployment/test target is under $5, not a guarantee.
- One Secrets Manager secret is retained (official list price $0.40/secret/month),
  plus usage-based hosting/storage and a CloudWatch alarm. Verify credit eligibility.

### Bedrock quota limitation and truthful fallback

Live metadata advertised Nova Lite image input/direct invocation, but the actual
Converse image call returned ThrottlingException. Service Quotas reported zero
Nova Lite inference allowance in Sydney, including direct and cross-region usage;
Nova 2 Lite quotas also reported zero. No quota increase or paid-plan upgrade was
requested. Configure `BedrockEnabled=false`, `RekognitionGuideFallback=true` while
this remains unresolved. This avoids futile model probes and retries.

The photo guide then uses real Rekognition labels, maps only supported material
clues, preserves raw confidences, and joins local sourced handling guidance. It
returns source=aws_rekognition, explicitly says Bedrock was not used, requires
resident review and never estimates weight from label-only results. Images with
no mapped waste material retain manual selection instead of inventing a category.
Assistant responses remain a locally composed, source-backed guide.

`WASTELENS_API_BASE_PATH=/prod` configures Mangum to strip the named API Gateway
stage. The first real deployment reproduced 404 /prod/health without this setting;
regression tests now cover stage routing.

The real fresh-bucket upload test also reproduced HTTP 307 from a presigned global
S3 hostname. Upload and photo-read signing now explicitly use the bucket's regional
virtual host and SigV4. A SDK-only regression verifies the regional upload/read
hostname and pending/final paths without contacting AWS. The initial pending report
was retained and retried against the same ID; a failed upload was not published.

### Pilot account sessions

The social frontend adds `#login` (email/password login and account creation) and
`#groups` (community registration). Account/session data uses the existing DynamoDB
table with separate keys and no public indexes; local development uses additive
SQLite tables. No new AWS authentication service is provisioned.

CloudFront API behavior must continue to use CachingDisabled and forward cookies
(the existing AllViewerExceptHostHeader policy does). Account responses are
`no-store`; cloud cookies are HttpOnly, Secure and SameSite=Strict. API Gateway and
FastAPI CORS allow credentials only for the exact configured frontend origin.
Passwords are salted scrypt hashes; opaque sessions are stored only by hash.

This is a pilot account implementation. Email verification/recovery, account deletion,
distributed authentication abuse controls and expired-session cleanup are not complete.
Account login does not transfer browser-owned guest reports to an account. Do not
claim verified resident identity or production authentication readiness.
