import "dotenv/config";
import crypto from "node:crypto";
import dns from "node:dns";
import express from "express";
import translate from "google-translate-api-x";
import {
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";

dns.setDefaultResultOrder("ipv4first");

const required = ["DISCORD_TOKEN", "DISCORD_GUILD_ID", "ROBLOX_SHARED_SECRET"];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing ${key}`);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
const app = express();
app.use(express.json({ limit: "64kb" }));

const state = {
  servers: new Map(),
  leaderboard: { wins: [], richest: [], streak: [], donate: [], fastest: [] },
  relayMessages: [],
  nextRelayId: 1,
  peakPlayers: 0,
  peakLoaded: false,
  totals: { joins: 0, leaves: 0, purchases: 0, chatMessages: 0, moderationActions: 0 },
};

const channelCache = new Map();
let liveStatusMessage = null;
let lastPresenceSignature = "";
let botUserId = "";
let presenceUpdateRunning = false;
let presenceUpdatePending = false;
let peakUpdateRunning = false;
let peakUpdatePending = false;

app.get("/", (_req, res) => res.json({ ok: true, service: "guess-the-distance-discord" }));
app.get("/health", (_req, res) => res.json({ ok: true }));

function authorized(req) {
  const received = Buffer.from(String(req.get("x-gtd-secret") || ""));
  const expected = Buffer.from(process.env.ROBLOX_SHARED_SECRET);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function clean(value, max = 200) {
  return String(value ?? "").replace(/@/g, "＠").replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

function isUsefulTranslation(source) {
  const normalized = source.toLowerCase().replace(/[^a-z]/g, "");
  if (!normalized || normalized.length < 2) return false;
  if (/^(?:ha)+h?$|^(?:he)+h?$|^(?:hi)+h?$|^(?:w?k)+w?$/.test(normalized)) return false;
  if (/^(lol|lmao|lmfao|rofl|xd+)$/.test(normalized)) return false;
  return true;
}

async function translateWebhookMessage(message) {
  const raw = String(message.content || "").trim();
  // The Roblox relay now includes its own translation. Do not translate it twice.
  if (!raw || raw.includes("🌐")) return;

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const playerMatch = line.match(/^([^:]{1,80}):\s*(.+)$/);
      return {
        player: playerMatch?.[1]?.trim() || "",
        source: playerMatch?.[2]?.trim() || line,
      };
    })
    .filter(({ source }) => isUsefulTranslation(source));
  if (!lines.length) return;

  try {
    // One batch request is much faster than translating every chat line one by one.
    const results = await translate(lines.map(({ source }) => source), {
      to: "en",
      autoCorrect: false,
      client: "gtx",
      rejectOnPartialFail: false,
    });
    const translatedLines = lines.flatMap(({ player, source }, index) => {
      const result = results[index];
      const translated = String(result?.text || "").trim();
      const detected = result?.from?.language?.iso;
      if (!translated || detected === "en" || translated.toLowerCase() === source.toLowerCase()) return [];
      return player
        ? [`**${clean(player, 80)}:** ${clean(translated, 500)}`]
        : [clean(translated, 500)];
    });
    if (!translatedLines.length) return;

    const content = `🌐 **English translation**\n${translatedLines.join("\n")}`;
    await discordApi(`/channels/${message.channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content: content.slice(0, 2000),
        allowed_mentions: { parse: [] },
      }),
    });
  } catch (error) {
    console.error(`Translation failed for ${message.id}:`, error.message);
  }
}

async function discordApi(path, options = {}) {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`Discord API ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function getBotUserId() {
  if (botUserId) return botUserId;
  const me = await discordApi("/users/@me");
  botUserId = me.id;
  return botUserId;
}

function detailText(value) {
  if (value == null) return "—";
  if (typeof value !== "object") return clean(value, 1000) || "—";
  return Object.entries(value)
    .filter(([, item]) => ["string", "number", "boolean"].includes(typeof item))
    .map(([key, item]) => `${clean(key, 50)}: ${clean(item, 200)}`)
    .join(" • ")
    .slice(0, 1000) || "—";
}

function productionPayload(body) {
  const jobId = clean(body?.jobId || body?.server?.jobId, 100).toLowerCase();
  const environment = clean(body?.server?.environment, 30).toLowerCase();
  if (!jobId || jobId === "studio") return false;
  return !environment || environment === "production";
}

async function channel(envName) {
  const id = process.env[envName];
  if (!id) return null;
  const cached = channelCache.get(id) || client.channels.cache.get(id);
  if (cached) {
    channelCache.set(id, cached);
    return cached;
  }
  const fetched = await client.channels.fetch(id).catch(() => null);
  if (fetched) channelCache.set(id, fetched);
  return fetched;
}

function allPlayers() {
  return [...state.servers.values()].flatMap((server) => server.players || []);
}

function applyPlayerEvent(jobId, event, player) {
  if (!jobId || !["join", "leave"].includes(event)) return;
  const existing = state.servers.get(jobId) || { players: [], server: {}, updatedAt: Date.now() };
  const playerKey = String(player.userId || player.name || "");
  if (!playerKey) return;
  const matches = (item) => String(item.userId || item.name || "") === playerKey;
  existing.players = event === "join"
    ? [...existing.players.filter((item) => !matches(item)), player].slice(0, 100)
    : existing.players.filter((item) => !matches(item));
  existing.updatedAt = Date.now();
  state.servers.set(jobId, existing);
  requestPresenceUpdate();
  if (event === "join") requestPeakUpdate();
}

function queueRelay(author, content) {
  const message = {
    id: state.nextRelayId++,
    author: clean(author, 80) || "Discord Staff",
    content: clean(content, 240),
    authorRobloxUserId: Number(process.env.ROBLOX_RELAY_AUTHOR_ID || 1552888256),
    createdAt: Date.now(),
  };
  if (!message.content) return null;
  state.relayMessages.push(message);
  state.relayMessages = state.relayMessages
    .filter((item) => item.createdAt > Date.now() - 10 * 60_000)
    .slice(-100);
  return message;
}

async function loadPeak() {
  if (state.peakLoaded) return;
  for (const envName of ["CHANNEL_ANNOUNCEMENTS", "CHANNEL_GAME_EVENTS"]) {
    const target = await channel(envName);
    if (!target?.isTextBased()) continue;
    const messages = await target.messages.fetch({ limit: 100 });
    for (const message of messages.values()) {
      for (const embed of message.embeds) {
        if (embed.title !== "New player peak!") continue;
        const players = Number(embed.fields?.find((field) => field.name === "Players")?.value || 0);
        if (players > state.peakPlayers) state.peakPlayers = players;
      }
    }
  }
  state.peakLoaded = true;
}

async function announcePeak() {
  await loadPeak();
  const count = allPlayers().length;
  if (count <= state.peakPlayers || count < 1) return;
  const previous = state.peakPlayers;
  state.peakPlayers = count;
  requestPresenceUpdate();
  const target = await channel("CHANNEL_ANNOUNCEMENTS");
  if (!target?.isTextBased()) return;
  const embed = new EmbedBuilder()
    .setTitle("New player peak!")
    .setDescription(`Guess the Distance just reached **${count} concurrent player${count === 1 ? "" : "s"}**.`)
    .addFields(
      { name: "Players", value: String(count), inline: true },
      { name: "Previous peak", value: String(previous), inline: true },
    )
    .setColor(0xf1c40f)
    .setTimestamp();
  await target.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function updatePresence() {
  if (!client.user) return;
  const players = allPlayers();
  const count = players.length;
  const serverCount = state.servers.size;
  const signature = JSON.stringify([
    count,
    serverCount,
    state.peakPlayers,
    ...players.slice(0, 25).map((player) => [player.userId, player.name, player.displayName, player.wins]),
  ]);
  if (signature === lastPresenceSignature) return;
  client.user.setActivity(`${count} player${count === 1 ? "" : "s"} guessing`);
  const target = await channel("CHANNEL_LIVE_PLAYERS");
  if (!target?.isTextBased()) return;
  const rows = players.slice(0, 25)
    .map((p) => `• **${clean(p.displayName || p.name)}** — ${Number(p.wins || 0).toLocaleString("en-US")} wins`)
    .join("\n");
  const embed = new EmbedBuilder()
    .setTitle("Guess the Distance • Live Status")
    .setDescription(rows || "No published servers currently have players online.")
    .addFields(
      { name: "Players", value: String(count), inline: true },
      { name: "Servers", value: String(serverCount), inline: true },
      { name: "Peak", value: String(state.peakPlayers), inline: true },
    )
    .setColor(0x5865f2)
    .setFooter({ text: "Published servers only • refreshes automatically" })
    .setTimestamp();
  if (!liveStatusMessage) {
    const messages = await target.messages.fetch({ limit: 10 });
    liveStatusMessage = messages.find((message) => {
      if (message.author.id !== client.user.id) return false;
      const title = message.embeds[0]?.title || "";
      return title === "Guess the Distance • Live Status" || title.startsWith("Live players:");
    }) || null;
  }
  try {
    liveStatusMessage = liveStatusMessage
      ? await liveStatusMessage.edit({ embeds: [embed] })
      : await target.send({ embeds: [embed], allowedMentions: { parse: [] } });
    lastPresenceSignature = signature;
  } catch (error) {
    liveStatusMessage = null;
    throw error;
  }
}

async function flushPresenceUpdates() {
  if (presenceUpdateRunning || !client.user) return;
  presenceUpdateRunning = true;
  try {
    do {
      presenceUpdatePending = false;
      await updatePresence();
    } while (presenceUpdatePending);
  } finally {
    presenceUpdateRunning = false;
  }
}

function requestPresenceUpdate() {
  presenceUpdatePending = true;
  void flushPresenceUpdates().catch((error) => console.error("Presence update failed:", error));
}

async function flushPeakUpdates() {
  if (peakUpdateRunning || !client.user) return;
  peakUpdateRunning = true;
  try {
    do {
      peakUpdatePending = false;
      await announcePeak();
    } while (peakUpdatePending);
  } finally {
    peakUpdateRunning = false;
  }
}

function requestPeakUpdate() {
  peakUpdatePending = true;
  void flushPeakUpdates().catch((error) => console.error("Peak update failed:", error));
}

async function announce(envName, title, fields, color = 0x57f287) {
  const channelId = process.env[envName];
  if (!channelId) return;
  const embed = new EmbedBuilder().setTitle(clean(title)).setColor(color).setTimestamp();
  embed.addFields(fields.map(([name, value, inline = true]) => ({
    name: clean(name, 100),
    value: detailText(value),
    inline,
  })));
  await discordApi(`/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({ embeds: [embed.toJSON()], allowed_mentions: { parse: [] } }),
  });
}

async function updateLeaderboardMessage(category) {
  const channelId = process.env.CHANNEL_LEADERBOARDS;
  if (!channelId) return;
  const rows = state.leaderboard[category] || [];
  const labels = { wins: "Most Wins", richest: "Richest Players", streak: "Best Streaks", donate: "Top Donators", fastest: "Fastest Times" };
  const formatValue = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return clean(value);
    if (category === "fastest") return `${((10_000_000_000 - number) / 1_000_000).toFixed(3)}s`;
    return Math.round(number).toLocaleString("en-US");
  };
  const body = rows.length
    ? rows.map((row, index) => `${["🥇", "🥈", "🥉"][index] || `**${index + 1}.**`} **${clean(row.displayName || row.name)}** — ${formatValue(row.value)}`).join("\n").slice(0, 3900)
    : "Waiting for the first game snapshot.";
  const embed = new EmbedBuilder()
    .setTitle(labels[category] || category)
    .setDescription(body)
    .setColor(0x9b59b6)
    .setFooter({ text: "Live production leaderboard • top 25" })
    .setTimestamp();
  const [messages, ownUserId] = await Promise.all([
    discordApi(`/channels/${channelId}/messages?limit=100`),
    getBotUserId(),
  ]);
  const previous = messages.find((message) => (
    message.author.id === ownUserId
      && message.embeds[0]?.title === (labels[category] || category)
  ));
  const payload = JSON.stringify({ embeds: [embed.toJSON()], allowed_mentions: { parse: [] } });
  if (previous) {
    await discordApi(`/channels/${channelId}/messages/${previous.id}`, {
      method: "PATCH",
      body: payload,
    });
  } else {
    await discordApi(`/channels/${channelId}/messages`, {
      method: "POST",
      body: payload,
    });
  }
}

app.use("/roblox", (req, res, next) => {
  if (!authorized(req)) return res.status(401).json({ error: "unauthorized" });
  next();
});

app.post("/roblox/heartbeat", (req, res) => {
  if (!productionPayload(req.body)) {
    return res.status(202).json({ ok: true, ignored: "non-production" });
  }
  const jobId = clean(req.body.jobId, 100);
  state.servers.set(jobId, {
    players: Array.isArray(req.body.players) ? req.body.players.slice(0, 100) : [],
    server: req.body.server || {},
    updatedAt: Date.now(),
  });
  res.json({ ok: true });
  requestPresenceUpdate();
  requestPeakUpdate();
});

app.post("/roblox/event", async (req, res) => {
  if (!productionPayload(req.body)) {
    return res.status(202).json({ ok: true, ignored: "non-production" });
  }
  const event = clean(req.body.event, 40);
  const p = req.body.player || {};
  if (event === "purchase") {
    state.totals.purchases += 1;
    await announce("CHANNEL_PURCHASES", "New Roblox purchase", [["Player", p.displayName || p.name], ["Item", req.body.itemName || req.body.productId], ["Robux", req.body.robux || "unknown"], ["User ID", p.userId]]);
  } else if (event === "chat" && process.env.ENABLE_CHAT_RELAY === "true") {
    state.totals.chatMessages += 1;
    await announce("CHANNEL_CHAT_LOG", "Game chat", [
      ["Display name", p.displayName || p.name],
      ["Username", `@${p.name || "unknown"}`],
      ["User ID", p.userId || "unknown"],
      ["Message", req.body.message, false],
    ], 0xfee75c);
  } else if (event === "record") {
    await announce("CHANNEL_ANNOUNCEMENTS", "New game record", [["Player", p.displayName || p.name], ["Details", req.body.details || "—", false]], 0xf1c40f);
  } else if (event === "moderation") {
    state.totals.moderationActions += 1;
    const details = req.body.details || {};
    await announce("CHANNEL_GAME_EVENTS", "Moderation action", [
      ["Moderator", p.displayName || p.name || "Unknown"],
      ["Action", details.action || "unknown"],
      ["Target", details.targetName || details.targetUserId || "Server"],
      ["Details", details.reason || details.message || details.result || details.failed, false],
    ], 0xed4245);
  } else if (event === "server_start") {
    await announce("CHANNEL_GAME_EVENTS", "Server online", [
      ["Server", req.body.jobId],
      ["Details", req.body.details, false],
    ], 0x57f287);
  } else if (event === "server_stop") {
    state.servers.delete(clean(req.body.jobId, 100));
    requestPresenceUpdate();
    await announce("CHANNEL_GAME_EVENTS", "Server offline", [
      ["Server", req.body.jobId],
      ["Details", req.body.details, false],
    ], 0x747f8d);
  } else if (["join", "leave", "round_win"].includes(event)) {
    if (event === "join") state.totals.joins += 1;
    if (event === "leave") state.totals.leaves += 1;
    applyPlayerEvent(clean(req.body.jobId, 100), event, p);
    await announce("CHANNEL_GAME_EVENTS", event.replaceAll("_", " "), [["Player", p.displayName || p.name], ["Details", req.body.details || "—", false]], 0x3498db);
  }
  res.json({ ok: true });
});

app.post("/roblox/leaderboard", async (req, res) => {
  if (!productionPayload(req.body)) {
    return res.status(202).json({ ok: true, ignored: "non-production" });
  }
  const category = clean(req.body.category, 30);
  if (Object.hasOwn(state.leaderboard, category) && Array.isArray(req.body.rows)) {
    state.leaderboard[category] = req.body.rows.slice(0, 25);
    await updateLeaderboardMessage(category);
  }
  res.json({ ok: true });
});

app.get("/roblox/messages", (req, res) => {
  const after = Math.max(0, Number(req.query.after) || 0);
  const messages = state.relayMessages.filter((message) => message.id > after).slice(0, 20);
  res.json({
    ok: true,
    messages,
    cursor: messages.at(-1)?.id || after,
  });
});

const commands = [
  new SlashCommandBuilder().setName("players").setDescription("Show active Guess the Distance players"),
  new SlashCommandBuilder().setName("status").setDescription("Show live production server and analytics status"),
  new SlashCommandBuilder()
    .setName("broadcast")
    .setDescription("Send a filtered staff message into every live Roblox server")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption((option) => option
      .setName("message")
      .setDescription("Message to display in-game")
      .setRequired(true)
      .setMaxLength(240)),
  new SlashCommandBuilder().setName("leaderboard").setDescription("Show a game leaderboard").addStringOption((o) => o.setName("category").setDescription("Leaderboard category").setRequired(true).addChoices(
    { name: "Wins", value: "wins" }, { name: "Richest", value: "richest" }, { name: "Streak", value: "streak" }, { name: "Donations", value: "donate" }, { name: "Fastest", value: "fastest" }
  )),
  new SlashCommandBuilder().setName("setup").setDescription("Create the recommended channel layout").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((c) => c.toJSON());

client.on("messageCreate", (message) => {
  if (process.env.ENABLE_WEBHOOK_TRANSLATION === "false") return;
  if (!message.webhookId || message.channelId !== process.env.CHANNEL_CHAT_LOG) return;
  void translateWebhookMessage(message);
});

function runGatewaySession() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
    let sequence = null;
    let heartbeat = null;

    const stop = () => {
      if (heartbeat) clearInterval(heartbeat);
    };

    socket.addEventListener("open", () => console.log("Discord gateway socket open"));
    socket.addEventListener("error", () => {
      stop();
      reject(new Error("Discord gateway socket error"));
    });
    socket.addEventListener("close", () => {
      stop();
      resolve();
    });
    socket.addEventListener("message", (event) => {
      const packet = JSON.parse(String(event.data));
      if (packet.s != null) sequence = packet.s;

      if (packet.op === 10) {
        const sendHeartbeat = () => socket.send(JSON.stringify({ op: 1, d: sequence }));
        heartbeat = setInterval(sendHeartbeat, packet.d.heartbeat_interval);
        socket.send(JSON.stringify({
          op: 2,
          d: {
            token: process.env.DISCORD_TOKEN,
            intents: 33281,
            properties: { os: "windows", browser: "gtd-translator", device: "gtd-translator" },
          },
        }));
      } else if (packet.op === 7 || packet.op === 9) {
        socket.close();
      } else if (packet.op === 0 && packet.t === "READY") {
        console.log(`Discord gateway ready as ${packet.d.user.username}`);
      } else if (packet.op === 0 && packet.t === "MESSAGE_CREATE") {
        const message = packet.d;
        if (process.env.ENABLE_WEBHOOK_TRANSLATION === "false") return;
        if (!message.webhook_id || message.channel_id !== process.env.CHANNEL_CHAT_LOG) return;
        void translateWebhookMessage({ id: message.id, channelId: message.channel_id, content: message.content });
      }
    });
  });
}

async function connectRawGateway() {
  while (true) {
    try {
      await runGatewaySession();
    } catch (error) {
      console.error("Raw Discord gateway failed:", error);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "players") {
    const players = allPlayers();
    await interaction.reply({ content: players.length ? players.map((p) => `• ${clean(p.displayName || p.name)} — ${Number(p.wins || 0)} wins`).join("\n").slice(0, 1900) : "No players are online.", ephemeral: true });
  } else if (interaction.commandName === "status") {
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle("Production status")
        .addFields(
          { name: "Players", value: String(allPlayers().length), inline: true },
          { name: "Servers", value: String(state.servers.size), inline: true },
          { name: "Peak", value: String(state.peakPlayers), inline: true },
          { name: "Joins", value: String(state.totals.joins), inline: true },
          { name: "Purchases", value: String(state.totals.purchases), inline: true },
          { name: "Moderation", value: String(state.totals.moderationActions), inline: true },
        )
        .setColor(0x5865f2)
        .setTimestamp()],
      ephemeral: true,
    });
  } else if (interaction.commandName === "broadcast") {
    const queued = queueRelay(
      interaction.user.globalName || interaction.user.username,
      interaction.options.getString("message", true),
    );
    await interaction.reply({
      content: queued
        ? `Queued for ${state.servers.size} live Roblox server${state.servers.size === 1 ? "" : "s"}.`
        : "Message was empty.",
      ephemeral: true,
    });
  } else if (interaction.commandName === "leaderboard") {
    const category = interaction.options.getString("category", true);
    const rows = state.leaderboard[category] || [];
    await interaction.reply({ content: rows.length ? rows.map((r, i) => `${i + 1}. ${clean(r.name)} — ${clean(r.value)}`).join("\n").slice(0, 1900) : "No leaderboard snapshot has arrived yet.", ephemeral: true });
  } else if (interaction.commandName === "setup") {
    const guild = interaction.guild;
    const category = await guild.channels.create({ name: "GUESS THE DISTANCE", type: ChannelType.GuildCategory });
    for (const name of ["welcome", "announcements", "live-players", "leaderboards", "purchases", "game-events", "support", "staff-logs"]) {
      await guild.channels.create({ name, type: ChannelType.GuildText, parent: category.id });
    }
    await interaction.reply({ content: "Recommended channel layout created. Copy the channel IDs into `.env`, then restart the bot.", ephemeral: true });
  }
});

client.once("clientReady", async () => {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, process.env.DISCORD_GUILD_ID), { body: commands });
  await loadPeak();
  await updatePresence();
  console.log(`Discord bot ready as ${client.user.tag}`);
});

setInterval(() => {
  const staleBefore = Date.now() - 180_000;
  let changed = false;
  for (const [jobId, server] of state.servers) {
    if (server.updatedAt < staleBefore) {
      state.servers.delete(jobId);
      changed = true;
    }
  }
  if (changed) requestPresenceUpdate();
}, 60_000);

app.listen(Number(process.env.PORT || 3000), () => console.log(`Roblox bridge listening on port ${process.env.PORT || 3000}`));

client.on("error", (error) => console.error("Discord client error:", error));
client.on("shardError", (error) => console.error("Discord gateway error:", error));
client.on("shardDisconnect", (event, shardId) => {
  console.warn(`Discord shard ${shardId} disconnected (${event.code})`);
});

async function connectDiscord() {
  while (!client.isReady()) {
    try {
      console.log("Connecting to Discord...");
      await Promise.race([
        client.login(process.env.DISCORD_TOKEN),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Discord connection timed out")), 30_000)),
      ]);
      if (client.isReady()) return;
    } catch (error) {
      console.error("Discord login failed; retrying:", error);
      client.destroy();
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

void connectRawGateway();
