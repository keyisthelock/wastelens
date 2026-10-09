# AWS deployment

This is a deployment recipe. The current workspace has not been deployed to an AWS account. Review costs, region availability, IAM, Bedrock model access, and the hackathon rules before running it.

## Requirements

- AWS CLI authenticated through an approved profile or IAM Identity Center.
- AWS SAM CLI, Docker, Python 3.13, and Node.js 22.
- Permission to create CloudFormation, Lambda, API Gateway, CloudFront, S3, DynamoDB, Secrets Manager, CloudWatch, Bedrock, and Rekognition resources.
- Bedrock model access enabled for the model you pass to SAM.

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

   Choose a stack name and region. The initial frontend is private and will not upload photos from its CloudFront address until the origin is updated.

3. Read the `WasteLensSiteUrl` and bucket outputs, then update the stack’s CORS origin to that exact URL (without a trailing slash):

   ```sh
   sam deploy --parameter-overrides AllowedOrigin=https://YOUR_DISTRIBUTION.cloudfront.net
   ```

4. Publish the built static frontend and invalidate the distribution cache:

   ```sh
   aws s3 sync frontend/dist s3://YOUR_FRONTEND_BUCKET --delete
   aws cloudfront create-invalidation --distribution-id YOUR_DISTRIBUTION_ID --paths '/*'
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

CloudFormation success confirms resources were created; it does not prove the model is enabled, every organization policy is compatible, or the application behaves correctly. Review the deployed stack and run the flow above.
