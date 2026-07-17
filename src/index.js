import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import fetch from 'node-fetch';

// ---- env ----
const {
  DISCORD_TOKEN,
  DISCORD_APP_ID,
  DISCORD_GUILD_ID,
  RPC_URL,
  USDC_ADDRESS,
  ALERT_CHANNEL_ID,
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_APP_ID || !RPC_URL || !USDC_ADDRESS) {
  console.error('Missing required env vars');
  process.exit(1);
}

// ---- basic JSON-RPC helper ----
let rpcId = 1;
async function rpcCall(method, params) {
  const body = {
    jsonrpc: '2.0',
    id: rpcId++,
    method,
    params,
  };

  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`RPC HTTP error ${res.status}`);
  }

  const json = await res.json();
  if (json.error) {
    throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  }
  return json.result;
}

// ---- ABI fragments we need ----
// Minimal ERC20 ABI for totalSupply & decimals.
const ERC20_ABI = {
  totalSupply: '0x18160ddd', // keccak("totalSupply()") first 4 bytes
  decimals: '0x313ce567',    // keccak("decimals()") first 4 bytes
};

// ---- helpers ----
function hexToBigInt(hex) {
  if (!hex || hex === '0x') return 0n;
  return BigInt(hex);
}

function formatUnits(valueBigInt, decimals) {
  const d = BigInt(decimals);
  const base = 10n ** d;
  const whole = valueBigInt / base;
  const frac = valueBigInt % base;

  if (frac === 0n) return whole.toString();

  const fracStr = frac.toString().padStart(Number(d), '0').replace(/0+$/, '');
  return `${whole.toString()}.${fracStr}`;
}

// Encode a simple ERC20 call: function selector + 32‑byte padded address (only for balanceOf).
function encodeFunctionCall(selector, address) {
  const addrNo0x = address.toLowerCase().replace(/^0x/, '');
  const padded = addrNo0x.padStart(64, '0');
  return selector + padded;
}

// ---- USDC reads ----
async function getTokenDecimals() {
  const data = ERC20_ABI.decimals;
  const result = await rpcCall('eth_call', [
    {
      to: USDC_ADDRESS,
      data,
    },
    'latest',
  ]);
  return Number(hexToBigInt(result));
}

async function getTotalSupply() {
  const data = ERC20_ABI.totalSupply;
  const result = await rpcCall('eth_call', [
    {
      to: USDC_ADDRESS,
      data,
    },
    'latest',
  ]);
  return hexToBigInt(result);
}

// ---- mint detection via logs ----
//
// Standard ERC20 Transfer topic:
// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Zero address in topics (indexed "from").
const ZERO_ADDRESS_TOPIC =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

let lastCheckedBlock = null;

async function pollMints(botClient) {
  try {
    const latestHex = await rpcCall('eth_blockNumber', []);
    const latestBlock = Number(hexToBigInt(latestHex));

    // Initial bootstrap: just set the lastCheckedBlock and return.
    if (lastCheckedBlock === null) {
      lastCheckedBlock = latestBlock;
      return;
    }

    // If nothing new, stop.
    if (latestBlock <= lastCheckedBlock) {
      return;
    }

    // Query logs between lastCheckedBlock+1 and latestBlock
    const fromBlock = `0x${(lastCheckedBlock + 1).toString(16)}`;
    const toBlock = `0x${latestBlock.toString(16)}`;

    const logs = await rpcCall('eth_getLogs', [
      {
        fromBlock,
        toBlock,
        address: USDC_ADDRESS,
        topics: [
          TRANSFER_TOPIC,
          ZERO_ADDRESS_TOPIC, // mints: from = 0x0
        ],
      },
    ]);

    if (logs && logs.length > 0 && ALERT_CHANNEL_ID) {
      const channel = botClient.channels.cache.get(ALERT_CHANNEL_ID);
      if (channel) {
        const decimals = await getTokenDecimals();
        for (const log of logs) {
          // data is the amount (uint256).
          const amount = hexToBigInt(log.data);
          const formatted = formatUnits(amount, decimals);

          const toAddr = '0x' + log.topics[2].slice(26); // last 20 bytes
          await channel.send(
            `New USDC mint detected: **${formatted}** to **${toAddr}** (block ${Number(
              hexToBigInt(log.blockNumber),
            )})`,
          );
        }
      }
    }

    lastCheckedBlock = latestBlock;
  } catch (err) {
    console.error('pollMints error:', err.message);
  }
}

// ---- Discord setup ----
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const commands = [
  {
    name: 'total',
    description: 'Show total USDC supply on MegaETH',
  },
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  if (DISCORD_GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(DISCORD_APP_ID, DISCORD_GUILD_ID),
      { body: commands },
    );
    console.log('Registered guild slash commands');
  } else {
    await rest.put(Routes.applicationCommands(DISCORD_APP_ID), {
      body: commands,
    });
    console.log('Registered global slash commands');
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();

  // Start mint polling every 5 seconds.
  setInterval(() => pollMints(client), 5000);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'total') {
    await interaction.deferReply();

    try {
      const [decimals, totalBn] = await Promise.all([
        getTokenDecimals(),
        getTotalSupply(),
      ]);
      const formatted = formatUnits(totalBn, decimals);
      await interaction.editReply(
        `Current USDC total supply on MegaETH: **${formatted}**`,
      );
    } catch (err) {
      console.error('total command error:', err.message);
      await interaction.editReply('Error fetching total supply from RPC.');
    }
  }
});

client.login(DISCORD_TOKEN);
