import 'dotenv/config';
import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';

const CONFIG = {
  discordToken: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  guildId: process.env.DISCORD_GUILD_ID || '',
  webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  pingRoleId: process.env.PING_ROLE_ID || '',
  updateMinutes: Number(process.env.UPDATE_MINUTES || 15),
  tokenAddress: '0x3600000000000000000000000000000000000000',
  blockscoutBase: 'https://arc-mainnet.cloud.blockscout.com/api/v2',
  stateFile: path.resolve('data/state.json')
};

if (!CONFIG.discordToken || !CONFIG.clientId) {
  throw new Error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in environment variables.');
}

fs.mkdirSync(path.dirname(CONFIG.stateFile), { recursive: true });

function loadState() {
  if (!fs.existsSync(CONFIG.stateFile)) {
    return { lastKnownSupply: null, lastMintKey: null, lastCheckedAt: null, recentMints: [] };
  }
  return JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
}

function saveState(state) {
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));
}

function formatUnits(raw, decimals = 6) {
  const value = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;
  const fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return fractionStr ? `${whole.toString()}.${fractionStr}` : whole.toString();
}

function formatNumber(str) {
  const [whole, frac] = str.split('.');
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${withCommas}.${frac}` : withCommas;
}

async function jsonFetch(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'arc-usdc-tracker/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function getTokenMeta() {
  return jsonFetch(`${CONFIG.blockscoutBase}/tokens/${CONFIG.tokenAddress}`);
}

async function getLatestUsdcMints() {
  const url = `${CONFIG.blockscoutBase}/addresses/0x0000000000000000000000000000000000000000/token-transfers?type=ERC-20`;
  const data = await jsonFetch(url);
  return (data.items || []).filter((item) =>
    item.token?.address_hash?.toLowerCase() === CONFIG.tokenAddress.toLowerCase()
  );
}

function mintKey(item) {
  return `${item.transaction_hash || item.tx_hash || item.block_hash}:${item.log_index}`;
}

function buildMintEmbed(item, supplyRaw, decimals) {
  const minted = formatNumber(formatUnits(item.total?.value || item.total?.amount || item.total || item.amount || item.value, decimals));
  const totalSupply = formatNumber(formatUnits(supplyRaw, decimals));
  const to = item.to?.hash || 'unknown';
  const txHash = item.transaction_hash || item.tx_hash || '';
  const txUrl = txHash ? `https://arc-mainnet.cloud.blockscout.com/tx/${txHash}` : null;

  const embed = new EmbedBuilder()
    .setTitle('ARC USDC Mint Detected')
    .setColor(0x2775ca)
    .addFields(
      { name: 'Minted', value: `${minted} USDC`, inline: true },
      { name: 'Total Supply', value: `${totalSupply} USDC`, inline: true },
      { name: 'Recipient', value: `\`${to}\``, inline: false },
      { name: 'Time', value: `<t:${Math.floor(new Date(item.timestamp).getTime() / 1000)}:R>`, inline: true }
    )
    .setFooter({ text: 'ARC Blockscout USDC tracker' })
    .setTimestamp(new Date(item.timestamp));

  if (txUrl) embed.setURL(txUrl);
  return embed;
}

async function sendWebhookMessage(payload) {
  if (!CONFIG.webhookUrl) return;
  const res = await fetch(CONFIG.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`Webhook failed: ${res.status}`);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let state = loadState();

async function poll() {
  const [token, mints] = await Promise.all([getTokenMeta(), getLatestUsdcMints()]);
  const decimals = Number(token.decimals || 6);
  const supplyRaw = token.total_supply;
  const latestMint = mints[0] || null;

  if (latestMint) {
    const latestKey = mintKey(latestMint);
    if (state.lastMintKey && latestKey !== state.lastMintKey) {
      const newMints = [];
      for (const item of mints) {
        const key = mintKey(item);
        if (key === state.lastMintKey) break;
        newMints.push(item);
      }
      newMints.reverse();
      for (const item of newMints) {
        const content = CONFIG.pingRoleId ? `<@&${CONFIG.pingRoleId}>` : '@here';
        const embed = buildMintEmbed(item, supplyRaw, decimals);
        await sendWebhookMessage({ content, embeds: [embed.toJSON()] });
      }
    }
    state.lastMintKey = latestKey;
    state.recentMints = mints.slice(0, 10).map((item) => ({
      key: mintKey(item),
      timestamp: item.timestamp,
      to: item.to?.hash || null,
      amount: item.total?.value || item.total?.amount || item.total || item.amount || item.value || '0'
    }));
  }

  state.lastKnownSupply = supplyRaw;
  state.lastCheckedAt = new Date().toISOString();
  saveState(state);
  return { token, latestMint };
}

const totalCommand = new SlashCommandBuilder()
  .setName('total')
  .setDescription('Show current ARC-chain USDC circulating supply');

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(CONFIG.discordToken);
  const body = [totalCommand.toJSON()];
  if (CONFIG.guildId) {
    await rest.put(Routes.applicationGuildCommands(CONFIG.clientId, CONFIG.guildId), { body });
  } else {
    await rest.put(Routes.applicationCommands(CONFIG.clientId), { body });
  }
}

client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
  await poll().catch((err) => console.error('Initial poll failed:', err));
  setInterval(() => {
    poll().catch((err) => console.error('Poll failed:', err));
  }, CONFIG.updateMinutes * 60 * 1000);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'total') return;

  try {
    const token = await getTokenMeta();
    const supply = formatNumber(formatUnits(token.total_supply, Number(token.decimals || 6)));
    const holders = token.holders_count || '0';
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('ARC USDC Supply')
          .setColor(0x2775ca)
          .addFields(
            { name: 'Total circulating', value: `${supply} USDC`, inline: true },
            { name: 'Holders', value: `${holders}`, inline: true },
            { name: 'Token', value: `\`${CONFIG.tokenAddress}\``, inline: false }
          )
          .setURL(`https://arc-mainnet.cloud.blockscout.com/token/${CONFIG.tokenAddress}`)
          .setFooter({ text: 'Source: ARC Blockscout' })
          .setTimestamp(new Date())
      ]
    });
  } catch (error) {
    await interaction.reply({ content: `Failed to fetch supply: ${error.message}`, ephemeral: true });
  }
});

client.login(CONFIG.discordToken);
