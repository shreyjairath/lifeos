---
description: Refresh the Gmail OAuth token when email processing fails with invalid_grant
---

Re-authenticate Gmail to get a new refresh token. Run this when email processing fails with `invalid_grant`.

!`cd /Users/shreyjairath/Projects/lifeos/packages/server && bun reauth-gmail.mjs`

A browser window will open for Google OAuth. After you authorize, the new refresh token is saved automatically to `.user-data/system/gmail-credentials.json`. No server restart needed.
