# Enable Google sign-in for WasteLens

The implementation uses Google's official Identity Services button and a
JavaScript callback. A **Web application OAuth client ID** is required.
No client secret, Google API key, Firebase project or AWS Cognito service is used.
Email/password accounts and guest reporting remain available.

## Google Cloud setup

1. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview).
   Create or select a project named WasteLens.
2. Complete the **Branding** / **Get started** setup: application name WasteLens,
   your support email and your developer contact email. Choose an **External**
   audience for residents outside your organization.
3. For an initial controlled demo, keep the app in **Testing** and add your own
   Google account and the demo participants under **Audience → Test users**.
   Check Google's current publishing requirements before opening it to everyone.
   Supply real homepage/privacy/terms links when required; do not claim a policy
   or domain verification that has not been completed.
4. Under **Clients**, select **Create client → Web application**. Add these
   **Authorized JavaScript origins**, without a path, hash or trailing slash:

   ```text
   https://d29b1yfg6ycbnb.cloudfront.net
   http://localhost
   http://localhost:5175
   http://127.0.0.1
   http://127.0.0.1:5175
   ```

   Add any other local preview port you actually use. This implementation uses
   a popup and JavaScript callback, so no authorized redirect URI is needed.
5. Copy the **Client ID**, ending in `.apps.googleusercontent.com`. This is a
   public application identifier. Do not send or commit a client secret.

Official instructions: [Google setup](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid).
Only basic sign-in identity (name, email and subject) is used; there is no
Drive, Gmail, contacts or calendar access.

## Configure the application

Set this **backend** environment variable and restart FastAPI:

```text
WASTELENS_GOOGLE_CLIENT_ID=YOUR_WEB_CLIENT_ID.apps.googleusercontent.com
```

No frontend environment variable is necessary. The login page reads the public
client ID from `/api/auth/google/config`. If it is empty or invalid, the button
is disabled with a clear message and Google's script is not loaded.

For the existing SAM deployment, add `GoogleClientId=YOUR_WEB_CLIENT_ID` to its
reviewed parameter overrides. Deploy the backend, security-header policy and
new frontend assets together. These integration changes have been published to
the existing Sydney site, with Google sign-in disabled at the user's request.
The template permits only the official Google
sign-in script, styles and iframe paths, allows its popup, and permits the
site's own camera while disabling microphones. A configured client ID and real
Google sign-in check are still needed before enabling the button.

Use the same website hostname for the frontend and API in production (`/api`);
third-party cookie restrictions can otherwise prevent session restoration.

## Sign-in behavior and boundaries

- The login page offers the Google button for both login and registration.
- A ten-minute, browser-bound nonce is issued with an HttpOnly cookie. The
  backend checks Google's RS256 signature, client audience, issuer, expiry,
  verified-email claim and nonce. Successful use atomically consumes the nonce.
- The resident receives the existing revocable, opaque 24-hour WasteLens cookie
  session. Google credentials are never returned in responses, placed in URLs,
  stored in browser storage or saved to the account database.
- Google accounts use a hash of Google's stable `sub` identity, not email, as
  their account key. Email/password and Google profiles are separate in this
  pilot; matching email addresses do **not** automatically link accounts.
- New fields are additive migrations. Existing password accounts retain their
  passwords and sessions. Google sign-in does not transfer ownership of guest
  reports from another browser.
- Google challenge rows use a separate, private DynamoDB partition with no
  public report index. Expired challenges are rejected; local expired rows are
  pruned on challenge creation. Cloud expired-row TTL cleanup is not configured.
- Ad blockers, popup restrictions or unavailable Google key retrieval produce
  a recoverable error. Email sign-in and guest reporting remain usable.

Google authentication is **prepared, not live-verified**, until a real client ID
is configured and a resident completes the Google popup on an allowed origin.
See [Google token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).

## Instant camera photos

The report form and personal waste guide both include **Take a photo**. Camera
permission is requested only after a tap. A rear camera is preferred when
available; users review or retake the JPEG before choosing **Use this photo**.
The image then follows the existing validation, normalization and upload flow.
It is not submitted automatically, and photo-sharing remains a separate choice.

Closing the preview, accepting a photo, leaving the page or unmounting the form
stops all media tracks. No audio is requested. HTTPS (or localhost) is required.
For denied/missing/busy cameras the UI explains the issue and retains file
upload; a native `capture="environment"` picker is offered as another option.
Some desktop browsers treat that native picker as an ordinary file chooser.

The interface is implemented; physical device capture and a real Google login
still require verification on the intended phones/browsers.
