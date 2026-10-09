# WasteLens architecture

```mermaid
flowchart LR
  Resident[Resident browser]
  UI[React and Vite]
  API[FastAPI modular monolith]
  SQLite[(SQLite local)]
  S3[(Private S3 photos)]
  DDB[(DynamoDB reports)]
  Bedrock[Amazon Bedrock]
  Rekognition[Amazon Rekognition]

  Resident --> UI
  UI -->|same-origin API| API
  API --> SQLite
  UI -->|short-lived signed upload| S3
  API -->|verify and normalize| S3
  API --> DDB
  API --> Bedrock
  API --> Rekognition
```

Local mode uses SQLite and local files. Cloud mode selects DynamoDB and S3 through environment settings. The API contract is the seam between these modes; AWS-specific storage is behind a small adapter, not a separate service.

## Data boundaries

- Public board reads omit exact address, photo URL and complaint draft, and round coordinates to two decimal places.
- The reporter's random bearer token is issued once and only its hash is stored. The browser keeps it in session storage for owner edits and deletion.
- The public map receives only rounded coordinates.
- A report remains private and pending until its photo is verified and normalized.
- Only status changes use an operator credential; local changes append an audit event, while cloud changes use a conditional DynamoDB transaction.
- Support votes are unique per report and hashed client token. Cloud support count and the unique marker are committed atomically.
- Assistant model calls do not include report content or location. Visible factual answers are assembled from allowlisted local data.

See [AWS deployment](deployment-aws.md) for the cloud controls and [API contract](api-contract.md) for endpoint shapes.
