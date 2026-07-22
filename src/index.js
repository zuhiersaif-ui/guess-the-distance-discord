import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
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

const required = ["DISCORD_TOKEN", "DISCORD_GUILD_ID", "ROBLOX_SHARED_SECRET"];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing ${key}`);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const app = express();
app.use(express.json({ limit: "64kb" }));

const state = {
  servers: new Map(),
  leaderboard: { wins: [], richest: [], streak: [], donate: [], fastest: [] },
};

app.get("/", (_req, res) => res.json({ ok: true, service: "guess-the-distance-discord" }));
app.get("/health", (_req, res) => res.json({ ok: true }));

function authorized(req) {
  const received = Buffer.from(String(req.get("x-gtd-secret") || ""));
  const expected = Buffer.from(process.env.ROBLOX_SHARED_SECRET);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function clean(value, max = 200) {
  return String(value ?? "").replace(/@/g, "＠").replace(/[\r\n]+/g, " ").slice(0, max);
}

async function channel(envName) {
  const id = process.env[envName];
  if (!id) return null;
  return client.channels.fetch(id).catch(() => null);
}

function allPlayers() {
  return [...state.servers.values()].flatMap((server) => server.players || []);
}

async function updatePresence() {
  if (!client.user) return;
  const count = allPlayers().length;
  client.user.setActivity(`${count} player${count === 1 ? "" : "s"} guessing`);
  const target = await channel("CHANNEL_LIVE_PLAYERS");
  if (!target?.isTextBased()) return;
  const rows = allPlayers().slice(0, 50).map((p) => `• ${clean(p.displayName || p.name)} — ${Number(p.wins || 0)} wins`).join("\n");
  const embed = new EmbedBuilder()
    .setTitle(`Live players: ${count}`)
    .setDescription(rows || "No players online")
    .setColor(0x5865f2)
    .setTimestamp();
  const messages = await target.messages.fetch({ limit: 10 });
  const previous = messages.find((m) => m.author.id === client.user.id && m.embeds[0]?.title?.startsWith("Live players:"));
  if (previous) await previous.edit({ embeds: [embed] });
  else await target.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function announce(envName, title, fields, color = 0x57f287) {
  const target = await channel(envName);
  if (!target?.isTextBased()) return;
  const embed = new EmbedBuilder().setTitle(clean(title)).setColor(color).setTimestamp();
  embed.addFields(fields.map(([name, value, inline = true]) => ({ name: clean(name, 100), value: clean(value, 1000) || "—", inline })));
  await target.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

app.use("/roblox", (req, res, next) => {
  if (!authorized(req)) return res.status(401).json({ error: "unauthorized" });
  next();
});

app.post("/roblox/heartbeat", async (req, res) => {
  const jobId = clean(req.body.jobId, 100);
  state.servers.set(jobId, { players: Array.isArray(req.body.players) ? req.body.players.slice(0, 100) : [], updatedAt: Date.now() });
  await updatePresence();
  res.json({ ok: true });
});

app.post("/roblox/event", async (req, res) => {
  const event = clean(req.body.event, 40);
  const p = req.body.player || {};
  if (event === "purchase") {
    await announce("CHANNEL_PURCHASES", "New Roblox purchase", [["Player", p.displayName || p.name], ["Item", req.body.itemName || req.body.productId], ["Robux", req.body.robux || "unknown"], ["User ID", p.userId]]);
  } else if (event === "chat" && process.env.ENABLE_CHAT_RELAY === "true") {
    await announce("CHANNEL_CHAT_LOG", "Filtered game chat", [["Player", p.displayName || p.name], ["Message", req.body.message, false]], 0xfee75c);
  } else if (["join", "leave", "round_win", "record"].includes(event)) {
    await announce("CHANNEL_GAME_EVENTS", event.replaceAll("_", " "), [["Player", p.displayName || p.name], ["Details", req.body.details || "—", false]], 0x3498db);
  }
  res.json({ ok: true });
});

app.post("/roblox/leaderboard", (req, res) => {
  const category = clean(req.body.category, 30);
  if (Object.hasOwn(state.leaderboard, category) && Array.isArray(req.body.rows)) state.leaderboard[category] = req.body.rows.slice(0, 25);
  res.json({ ok: true });
});

const commands = [
  new SlashCommandBuilder().setName("players").setDescription("Show active Guess the Distance players"),
  new SlashCommandBuilder().setName("leaderboard").setDescription("Show a game leaderboard").addStringOption((o) => o.setName("category").setDescription("Leaderboard category").setRequired(true).addChoices(
    { name: "Wins", value: "wins" }, { name: "Richest", value: "richest" }, { name: "Streak", value: "streak" }, { name: "Donations", value: "donate" }, { name: "Fastest", value: "fastest" }
  )),
  new SlashCommandBuilder().setName("setup").setDescription("Create the recommended channel layout").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((c) => c.toJSON());

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "players") {
    const players = allPlayers();
    await interaction.reply({ content: players.length ? players.map((p) => `• ${clean(p.displayName || p.name)} — ${Number(p.wins || 0)} wins`).join("\n").slice(0, 1900) : "No players are online.", ephemeral: true });
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

client.once("ready", async () => {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, process.env.DISCORD_GUILD_ID), { body: commands });
  await updatePresence();
  console.log(`Discord bot ready as ${client.user.tag}`);
});

setInterval(() => {
  const staleBefore = Date.now() - 180_000;
  for (const [jobId, server] of state.servers) if (server.updatedAt < staleBefore) state.servers.delete(jobId);
  updatePresence().catch(console.error);
}, 60_000);

await client.login(process.env.DISCORD_TOKEN);
app.listen(Number(process.env.PORT || 3000), () => console.log(`Roblox bridge listening on port ${process.env.PORT || 3000}`));
