# Final app check — 11 October 2026

## Fixes

- Desktop sidebar and main content now have separate viewport-sized scroll areas.
  The previous sticky sidebar had no bounded overflow area, so a wheel gesture
  could scroll the entire page and leave the sidebar's lower content inaccessible.
- Navigation resets the content pane for home, accounts and communities. Feed,
  guide and how-it-works links reach their sections. Clicking the current home
  link works after scrolling; the sidebar keeps its own position.
- Both panes stop scrolling behind report dialogs. The footer belongs to the
  content pane and remains reachable. Small screens retain normal page scrolling.
- The reveal observer now runs after page changes. Previously, returning from
  login to the feed could leave newly mounted guide panels transparent.

## Checks run

| Check | Result |
| --- | --- |
| Backend unittest suite | 97 passed |
| Frontend Node test suite | 60 passed, including 5 new navigation regressions |
| Vite production build | Passed |
| Desktop keyboard scrolling at 1280 × 650 | Sidebar scrolled while main stayed at 0; main then scrolled while sidebar kept its position; document stayed at 0 |
| Wrapped header at 1024 × 768 | Both panes fit below the header; no document overflow |
| Mobile at 390 × 844 | Sidebar hidden, ordinary document scrolling, no horizontal overflow |
| Login → guide navigation on mobile | Guide heading and cards became visible; section reached the viewport |
| Dialog and footer | Background panes locked; footer reachable inside main content |
| Existing live site/API | Entry, health, reports, communities, anonymous account, AI status and submission status returned 200 |

## Synthetic local reporting flow

The current React form uploaded the non-sensitive synthetic test JPEG and created
report `9701e5ef-7444-4149-93e4-7875533a7100`. The address is explicitly marked as a
synthetic check, not a real waste sighting. AWS AI and complaint email were disabled
in this isolated local server.

The report returned through the API with HTTP 200, appeared in the community board,
and reopened through its saved link after a browser reload. An independent SQLite
read confirmed `upload_state=ready`, `photo_public=false`, `submission_state=not_sent`
and the normalized JPEG on disk. The owner view retained its edit controls and
recoverable optional-analysis messages. The test database and photo remain under
`/private/tmp/wastelens-final-check`; no resident data was used or migrated.

## Limits

Cloud-upload failure/retry coverage in this run is mocked. Today's live requests
were read-only application checks; no fresh Bedrock/Rekognition inference or cloud
report creation is claimed. Earlier real AWS upload and Rekognition checks are
recorded in [AWS verification](aws-integration-verification.md).

Bedrock remains disabled because of the account quota documented there. Google
sign-in remains unconfigured, SES remains disabled, and physical camera/GPS
accuracy still requires a user device check. No municipal email was sent.

## Publication

Published only the frontend to the existing Sydney S3 bucket and CloudFront site
after verifying the expected temporary non-root identity. Older assets were
retained. Entry-page invalidation completed; the new JavaScript and CSS both
returned HTTP 200. Live browser inspection confirmed separate `overflow:auto`
panes and that scrolling the feed leaves the sidebar and document in place.
No infrastructure, backend, model settings or stored community data changed.
