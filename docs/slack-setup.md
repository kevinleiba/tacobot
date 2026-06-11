# Slack App Setup (one-time, manual)

Operator checklist for configuring the Slack app that backs Tacobot. Required before the bot can receive events or admins can sign in.

## 1. Create the app

Go to <https://api.slack.com/apps?new_app=1> → **From scratch**.

- App name: `Tacobot`
- Workspace: `wlt-and-shaman`

## 2. Bot token scopes

Slack app dashboard → **OAuth & Permissions** → **Bot Token Scopes**. Add:

- `chat:write`
- `reactions:write`
- `reactions:read`
- `users:read`
- `channels:history`
- `groups:history`
- `im:history`
- `app_mentions:read`
- `team:read`

## 3. Event subscriptions

**Event Subscriptions** → toggle **Enable Events** on.

- Request URL: `https://tacobot.weblab.technology/api/slack/events`
  - During setup, point at a Vercel preview URL.
  - On launch, flip to the production URL.
- Subscribe to bot events:
  - `message.channels`
  - `message.im`
  - `app_mention`
  - `reaction_added`
  - `reaction_removed`
  - `team_join`
  - `user_change`

  `message.channels` covers both new messages and `message_deleted`
  subtype events — Slack delivers deletions through the same event type.
  `reaction_removed` is a separate subscription.

Save changes. Slack issues a verification challenge against the request URL; the route handler echoes it back. Confirm the green check.

## 4. Sign in with Slack (admin pages)

**OAuth & Permissions** → **Redirect URLs**. Add:

- `https://tacobot.weblab.technology/api/auth/callback/slack`

In **OpenID Connect** (or **User Token Scopes**, depending on the dashboard layout), add:

- `openid`
- `profile`
- `email`

## 5. Install the app to the workspace

**Install App** → **Install to Workspace** → **Allow**. Then collect:

| Value | From | Env var |
|---|---|---|
| Bot User OAuth Token (`xoxb-…`) | OAuth & Permissions → after install | `SLACK_BOT_TOKEN` |
| Signing Secret | Basic Information | `SLACK_SIGNING_SECRET` |
| Client ID | Basic Information | `SLACK_CLIENT_ID` |
| Client Secret | Basic Information | `SLACK_CLIENT_SECRET` |
| Bot User ID | App Home → Bot details | `SLACK_BOT_USER_ID` |

## 6. Channel IDs for the allowlist

Right-click the channel in Slack → **View channel details** → ID at the bottom. Or read it from the URL: `/archives/C0123ABCDE`.

Set `TACO_CHANNELS=<id>` (comma-separated for multiple). During the beta:

```bash
TACO_CHANNELS=<id of #taqueria-beta>
```

After cutover from HeyTaco:

```bash
TACO_CHANNELS=<id of #taqueria>
```

## 7. Invite the bot

In Slack, run inside the allowlisted channel(s):

```
/invite @tacobot
```

The bot must be a member of every channel in `TACO_CHANNELS`. Slack only delivers `message.channels` events for channels where the bot is a member, so this is the natural enforcement.

## 8. Admin allowlist

Set `ADMIN_SLACK_IDS` to the comma-separated Slack user IDs that should have access to `/admin/*` pages. Adding/removing an admin is an env-var change + redeploy.

## 9. Interactivity & Shortcuts (self-serve shop)

Required for the `#tacoshop` order announcement message buttons (`Mark fulfilled`, `Cancel & refund`).

**Interactivity & Shortcuts** → toggle on. Set:

- Request URL: `https://tacobot.weblab.technology/api/slack/events`

Same URL as the events endpoint — the App Router receiver routes both JSON events and form-urlencoded interactivity payloads.

Save changes.

## 10. `#tacoshop` channel

Create or pick a Slack channel for order announcements (e.g. `#tacoshop`). Invite the bot:

```
/invite @tacobot
```

Set `TACOSHOP_CHANNEL_ID` to its channel ID (right-click → View channel details → ID at the bottom).

Then flip the feature flag to enable self-serve shopping:

```bash
SHOP_SELF_SERVE_ENABLED=true
```

With the flag off, `/shop` keeps its legacy catalog (no Buy buttons, no #tacoshop link).

## 11. (Optional) Custom currency emoji

Tacobot always accepts `:taco:`. To additionally accept a workspace-custom emoji (for branded recognition like `:wltaco:`), set `TACO_ALT_EMOJI_NAME` to the emoji **name only** — no colons.

Requirements:

- The emoji must already exist in the workspace's custom emoji set (Slack → workspace settings → Customize → Emoji). The bot doesn't create it.
- The bot's existing `reactions:write` scope (step 2) is enough to add the alt emoji as its confirmation reaction (when enabled — see `TACO_REACT_ON_GIVE` below); no extra scope.

When set, both `:taco:` and the alt emoji count for typed mentions and reactions. If `TACO_REACT_ON_GIVE=true` (default `false`), the bot's own confirmation reaction uses the alt emoji. The bot's DM/reply prose (over-allowance ephemeral, give-success summaries, reversal notifications, grant DMs, leaderboard/help replies) also leads with the alt emoji's shortcode, so the workspace branding shows everywhere the bot speaks. The exception is reaction-removed DMs, which echo whichever emoji was actually removed, and the help text's instructional `:taco:` (always literal — `:taco:` is always in the accepted set).
