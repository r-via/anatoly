# Telegram Notifications

Anatoly can send a summary of each audit to Telegram. One bot serves the whole team -- each developer just adds their username to the config.

## Quick start (first time)

Run the interactive setup wizard:

```bash
anatoly notifications create-bot
```

The wizard walks you through:

1. Creating a bot via [@BotFather](https://t.me/botfather)
2. Pasting and verifying the bot token
3. Saving the token to `.env` (gitignored)
4. Sending `/start` to the bot
5. Updating `.anatoly.yml` with your username
6. Sending a test notification

After the wizard, your config looks like:

```yaml
# .anatoly.yml
notifications:
  telegram:
    enabled: true
    username: "YourUsername"
```

And your `.env` contains:

```
ANATOLY_TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
```

That's it. The next `anatoly run` will send you a message when the report is ready.

## Adding team members

The bot is shared. Once `create-bot` has been run once for the project, other developers only need to:

1. Send `/start` to the bot (the wizard prints the bot link, e.g. `t.me/anatoly_audit_bot`)
2. Add their username to `.anatoly.yml`:

```yaml
notifications:
  telegram:
    enabled: true
    username: "TheirUsername"
```

Anatoly resolves the username to a chat ID automatically on first notification, then caches it in `.anatoly/telegram-chat-ids.json`.

## Testing

```bash
anatoly notifications test
```

Sends a test message with sample data to verify connectivity. If the username hasn't been resolved yet, the command resolves and caches it first.

## Sending notifications manually

Use `--notify` on the `report` command to trigger a notification from an existing report:

```bash
anatoly report --notify
```

Useful when re-generating a report or in CI pipelines where `run` and `report` are separate steps.

## Configuration reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `false` | Enable Telegram notifications |
| `username` | string | *(none)* | Your Telegram username (without `@`). Resolved to a chat ID automatically |
| `chat_id` | string | *(none)* | Explicit chat ID. Overrides `username` when both are set. Use for groups/channels |
| `bot_token_env` | string | `"ANATOLY_TELEGRAM_BOT_TOKEN"` | Environment variable holding the bot token |
| `report_url` | string (URL) | *(none)* | Optional URL appended as a clickable link in the message |

Either `username` or `chat_id` is required when `enabled` is `true`.

### Minimal config (personal)

```yaml
notifications:
  telegram:
    enabled: true
    username: "YourUsername"
```

### Group/channel config

```yaml
notifications:
  telegram:
    enabled: true
    chat_id: "-1001234567890"    # Group or channel ID (negative number)
```

### CI config with report link

```yaml
notifications:
  telegram:
    enabled: true
    username: "CIBot"
    report_url: "https://ci.example.com/artifacts/anatoly/report.md"
```

## Message format

The Telegram message contains:

- **Verdict** -- CLEAN, NEEDS_REFACTOR, or CRITICAL
- **File stats** -- total, clean, findings, errors
- **Cost and duration**
- **Axis scorecard** -- per-axis finding counts (high/medium/low), only for axes with findings
- **Top findings** -- the most actionable findings, truncated to fit Telegram's 4096-character limit
- **Report link** -- clickable link to the full report (when `report_url` is set)

## Error handling

Notifications are non-blocking:

- If the bot token env var is missing, a warning is logged and the run continues.
- If the username can't be resolved (user hasn't sent `/start`), a warning is logged.
- If the Telegram API returns an error, a warning is logged.
- The audit report is always generated regardless of notification success.

## Extending to other channels

The notification system is built on a generic `NotificationChannel` interface:

```typescript
interface NotificationChannel {
  send(payload: NotificationPayload): Promise<void>;
}
```

New channels (Slack, Discord, webhooks) can be added by implementing this interface and registering the channel in `src/core/notifications/index.ts`.
