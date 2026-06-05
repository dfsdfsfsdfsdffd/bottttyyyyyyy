# Softcard Discord Presence Bot

Small Railway worker that listens to Discord presence updates and pushes them to Softcard.

## Discord Developer Portal

Enable these bot settings:

- Presence Intent
- Server Members Intent

Invite the bot into the server where it should watch users.

## Railway

Create a new Railway service from this repo and set the root directory to:

```txt
discord-presence-bot
```

Set these variables:

```txt
DISCORD_BOT_TOKEN=your_bot_token
SOFTCARD_PRESENCE_ENDPOINT=https://softcard.cc/api/discord/presence
SOFTCARD_PRESENCE_SYNC_SECRET=the_same_secret_you_set_on_vercel
WATCHED_DISCORD_IDS=
```

`WATCHED_DISCORD_IDS` is optional. If your server is big, add connected user IDs there so the bot does not try syncing everyone.

Start command:

```txt
npm start
```

## Vercel

Your website needs the same secret:

```txt
DISCORD_PRESENCE_SYNC_SECRET=the_same_secret_you_set_on_railway
```
