# Initial local verification access

Proposed region: Mumbai (`ap-south-1`), matching the existing example configuration.
Confirm this choice with the owner before authenticating/invoking services.

`wastelens-local-verification.json` is a policy template, not an applied policy.
Replace `YOUR_12_DIGIT_ACCOUNT_ID` in the Sign-In resource ARN with your actual
12-digit account ID before saving it in IAM. Keep that rendered copy outside Git.
IAM policy variables are allowed only in the ARN resource portion, not the account
segment; the earlier `${aws:PrincipalAccount}` account-segment proposal was invalid.
It grants temporary same-device CLI browser login for the current account in Mumbai,
Bedrock model/profile metadata reads and Rekognition label/moderation inference in
Mumbai. Rekognition uses Resource `*` because these image-byte operations do not
support individual resource ARNs; the requested region is restricted. Bedrock
metadata is read-only. No resource creation, IAM management, deployment, S3/DynamoDB
writes, email or Bedrock InvokeModel permission is granted.

After model metadata is verified, propose an exact model/profile invocation policy
for separate owner review. Do not attach AdministratorAccess or generate access keys.
Inference permissions allow billed calls; the application/operator must still limit
use and verify trial-credit eligibility. This policy is not a spending cap.

The owner applies account changes themselves from their root session. The agent
must not operate that root session. Use an existing non-root federated identity if
available. If using an IAM console user, keep its password private and enable MFA;
obtain only temporary CLI credentials via browser login. Console password is not an
API access key. Review and remove the test identity/permissions when no longer needed.

Some new AWS accounts use a new projects/team experience that does not support
IAM console users. If IAM does not offer console access, use the supported team /
federated sign-in flow instead; do not create static API keys as a workaround.

References:
- https://docs.aws.amazon.com/IAM/latest/UserGuide/id_users_create.html
- https://docs.aws.amazon.com/aws-managed-policy/latest/reference/SignInLocalDevelopmentAccess.html
- https://docs.aws.amazon.com/signin/latest/userguide/command-line-sign-in.html

Policy-variable reference: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_variables.html
