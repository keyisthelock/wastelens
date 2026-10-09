# WasteLens API contract

Base path: `/api`. JSON responses use snake_case. The authoritative machine-readable contract is the FastAPI OpenAPI document at `/openapi.json`.

| Method and path | Request | Purpose |
| --- | --- | --- |
| `POST /reports` | multipart: `photo`, `latitude`, `longitude`, optional `address` | Create a report and store its photo |
| `GET /reports` | optional `status`, `limit` | List community reports |
| `GET /reports/{id}` | — | Fetch a report |
| `POST /reports/{id}/analyze` | `{}` or `{ "categories": ["plastic"], "severity": "medium" }` | Analyze with Rekognition if configured; optional resident-entered values save a manual review |
| `POST /reports/{id}/complaint` | `{}` or `{ "draft": "edited text" }` | Draft or save an edited complaint; does not send it |
| `POST /reports/{id}/support` | `{}` | Add one support per client token |
| `PATCH /reports/{id}/status` | `{ "status": "reviewed" }` | Update community status; no municipal status is implied |
| `GET /authorities` | optional `city` | List verified directory entries for a configured pilot city; unknown cities return no match |
| `GET /ai/status` | — | Report whether Strands and a Bedrock region are configured |
| `POST /assistant` | `{ "message": "...", "report_id": "optional" }` | Ask the field guide about the board, verified authority channels, or possible nearby duplicates |

Statuses are `community_reported`, `reviewed`, and `cleanup_confirmed`. `cleanup_confirmed` is a community-recorded status, not a municipal verification. The Lucknow entry is based on Lucknow Nagar Nigam's official helpline page. It is a city-level candidate; the app does not check exact municipal boundaries from coordinates. Unknown or unconfigured authority coverage is returned as such rather than guessed. The complaint portal is an external link; WasteLens never submits the draft.

The assistant response includes `mode`, `ai_used`, and `ai_status`. If Bedrock is not configured or a request fails, it uses local intent matching. With Bedrock, Strands classifies the question into one exact allowlisted intent. The model has no tools or report context, and its free-form output is never shown to residents. WasteLens composes visible answers locally from the verified authority directory and SQLite data; proximity checks are calculated locally. Photos, exact coordinates, and report summaries are not passed to Bedrock. A proximity match is only a suggestion, not a confirmed duplicate.

The report action and the verified municipal portal are separate destinations: `POST /reports` stores a WasteLens community report; residents open and submit any municipal complaint themselves on the official external portal.
