---
description: Refresh the Gmail OAuth token when email processing fails with invalid_grant
---

Re-authenticate Gmail to get a new refresh token. Run this when email processing fails with `invalid_grant`.

!`cd /Users/shreyjairath/Projects/lifeos/packages/server && bun reauth-gmail.mjs`

!`cp /Users/shreyjairath/Projects/lifeos/.user-data/clients/shrey/system/gmail-credentials.json /Users/shreyjairath/Projects/lifeos/.user-data/clients/nishant/system/gmail-credentials.json && cp /Users/shreyjairath/Projects/lifeos/.user-data/clients/shrey/system/gmail-credentials.json /Users/shreyjairath/Projects/lifeos/.user-data/clients/akanksha/system/gmail-credentials.json && echo "✓ Token synced to nishant and akanksha"`

A browser window will open for Google OAuth. After you authorize, the new refresh token is saved automatically to all 3 clients (shrey, nishant, akanksha). No server restart needed.
