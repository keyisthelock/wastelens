# WasteLens

WasteLens helps Lucknow residents turn a photo of unmanaged waste into a reviewed community report, a source-backed recovery suggestion, and an editable complaint draft. Residents choose whether to copy or use the draft; WasteLens does not submit complaints to a municipality.

## MVP

- Photo and location report creation, a community board, report status, and deduplicated resident support.
- Optional image labels from Rekognition and structured material/mass suggestions from Bedrock. AI suggestions need human review; severity is resident-recorded.
- Source-backed Lucknow recovery guidance. Local intake is explicitly marked unverified where we could not verify an active receiving site.
- Approximate Lucknow pilot extent guard; it is not ward-level jurisdiction verification.
- Estimates are labelled. CO₂e is an illustrative EPA WARM food-waste proxy, not a measured diversion result. Cleanup costs are not estimated.
- A bounded Strands-based field guide. Bedrock may classify an allowlisted intent; WasteLens composes visible answers from its local verified directory and report data.
- An OpenStreetMap/Leaflet community map with clustered, rounded report locations.

## Run locally

Requirements: Python 3.13 and Node.js 22.

```sh
cd backend
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-lock.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

In another terminal:

```sh
cd frontend
npm ci
npm run dev -- --host 127.0.0.1
```

Open the Vite URL, normally http://127.0.0.1:5173. API docs are at http://127.0.0.1:8000/docs. Local reports and normalized photos are stored in `backend/data/` and `backend/uploads/`; they are excluded from Git.

## Security and privacy

The browser sees rounded public coordinates; addresses, photos, and complaint drafts require a report-scoped owner token. The server creates a random token once and stores its SHA-256 hash. The browser keeps the token in `sessionStorage`, so reporter controls last for that browser session. Reports can be deleted by their owner. Status changes require a separate operator credential and record a status event.

Photos are checked against their file signature, decoded and re-encoded as JPEG, resized, and stripped of EXIF metadata. Cloud uploads use a five-minute presigned S3 URL for one pending object; the API verifies content type and size, normalizes the image again, and only then makes the report visible. Abandoned pending photo objects expire automatically.

The AWS SAM template configures private S3 buckets with public access blocked and at-rest encryption, DynamoDB KMS encryption and point-in-time recovery, short log retention, scoped IAM permissions, HTTPS-only photo access, browser security headers, Secrets Manager for the operator token, and API Gateway throttling. These are deployment settings in code; they are **not active in local mode**. Local SQLite is not encrypted by WasteLens. Do not enter sensitive personal information into a local demo.

AWS storage status only reports whether the expected environment settings are present; it does not inspect the account to prove every control is active. No AWS deployment or real Bedrock/Rekognition request has been verified in this workspace. Use the deployment steps below and perform an account-side check before making cloud-security claims.

No municipal complaint is submitted. The user must review the draft and choose whether to copy it or open the official municipal channel.

## Optional AWS services

The app uses the open-source Strands Agents SDK. Optional managed services are Amazon Bedrock for allowlisted intent routing and multimodal image classification, Amazon Rekognition for image labels/moderation, AWS Lambda + API Gateway, private S3 photo storage, and DynamoDB reports. The local SQLite mode remains available without AWS credentials. See [AWS deployment](docs/deployment-aws.md).

Use an AWS IAM Identity Center or other approved credential provider; do not commit access keys. Enable the configured Bedrock model in the selected region before invoking it. Bedrock gets the assistant question only, not report photos or exact location. Rekognition and Bedrock receive image data only when the reporter requests image analysis.

## API

The API contract is documented in [`docs/api-contract.md`](docs/api-contract.md); FastAPI publishes the OpenAPI schema at `/openapi.json`. The frontend and backend stay in separate directories in one modular monolith.

## Hackathon demo

The [Environmental Hacks page](https://www.wemakedevs.org/aws/env) lists the tracks and tools. Follow the [official rules](https://www.wemakedevs.org/aws/env/rules): verify build timing, AWS usage and demo requirements directly. The project tree had no prior Git history; the initial repository history must reflect the actual work and must not be backdated or reconstructed. This workspace has not been deployed to AWS, so do not describe a local fallback as a live AWS invocation. Use [`docs/demo-script.md`](docs/demo-script.md) after you verify the deployed stack and model access.

## Development checks

```sh
cd backend && .venv/bin/python -m unittest discover -s tests -v
cd frontend && npm ci && npm run build
```

`backend/requirements.txt` pins direct dependencies; `backend/requirements-lock.txt` pins the tested environment. `frontend/package-lock.json` locks npm dependencies. GitHub Actions runs the backend suite and frontend production build.

## Locality data

Lucknow authority details and recovery routes include their source URLs and verification dates. Add an authority only after confirming its live service area and contact details from an official source. WasteLens does not infer municipal ward coverage from a point inside its approximate pilot box.

OpenStreetMap map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright). Browser tiles come from the community tile service and are loaded only for the viewed map; attribution and usage follow the [OSM tile policy](https://operations.osmfoundation.org/policies/tiles/).
