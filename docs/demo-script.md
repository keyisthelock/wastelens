# WasteLens demo script (about 3 minutes)

Use this script only after a real AWS deployment and account-side checks. Do not present sample or local data as live municipal or AWS data.

1. **Set the scope (20 seconds).** “WasteLens is a Lucknow pilot. It turns one photo into a reviewable report and a community action. Residents can choose to send an approved complaint email to LNN’s published public contact; this is not a ticketing integration.”
2. **Create a report (45 seconds).** Upload a demo photo, select a Lucknow-area location, and submit. Show the status, AI suggestion, and resident correction controls. Point out any unavailable model as unavailable.
3. **Show the community (35 seconds).** Open the clustered OpenStreetMap view, filter reports, and support one report twice to show that the count remains deduplicated.
4. **Show the human checkpoint (35 seconds).** Edit the draft, inspect the recipient and disclosed fields, confirm the location/jurisdiction and approve the separate send action. Explain that SES acceptance means an email was accepted for delivery, not that LNN received it or created a ticket. If SES is not deployed and verified, show the disabled email state and use the official portal link.
5. **Show AWS (40 seconds).** In the AWS console, show the Lambda/HTTP API, private S3 bucket and encryption, DynamoDB table/PITR, and the observed Bedrock/AI status. A configured region alone is not proof of invocation.
6. **Close with the estimate (20 seconds).** Explain that any mass and CO₂e values are labelled estimates with a source and scope note, not measured diversion or cleanup results.
