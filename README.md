# ARC USDC Discord Tracker

Tracks ARC-chain USDC at `0x3600000000000000000000000000000000000000` using Blockscout.

## Features
- Polls every 15 minutes by default.
- Reads current USDC total supply from ARC Blockscout API.
- Watches zero-address ERC-20 transfers to detect fresh USDC mints.
- Sends a Discord webhook alert when a new mint appears.
- Supports `/total` slash command to show current USDC circulating supply.

## Data source
- Token metadata: `https://arc-mainnet.cloud.blockscout.com/api/v2/tokens/0x3600000000000000000000000000000000000000`
- Mint feed basis: `https://arc-mainnet.cloud.blockscout.com/api/v2/addresses/0x0000000000000000000000000000000000000000/token-transfers?type=ERC-20`

## Setup
1. Create a Discord bot in the developer portal.
2. Enable the **applications.commands** scope and invite the bot to your server.
3. Create a Discord webhook in the target channel for mint alerts.
4. Copy `.env.example` to `.env` and fill the values.
5. Install dependencies: `npm install`
6. Start: `npm start`

## Notes
- The bot keeps last seen mint and last supply in `data/state.json`.
- On first boot it initializes state and does not backfill old mints.
- If you set `DISCORD_GUILD_ID`, the `/total` command registers instantly for that guild.
- If you leave `PING_ROLE_ID` empty, alerts default to `@here`.
