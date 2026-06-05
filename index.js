import {
  ActivityType,
  Client,
  GatewayIntentBits,
  Partials,
} from "discord.js";

const token = process.env.DISCORD_BOT_TOKEN;
const endpoint = process.env.SOFTCARD_PRESENCE_ENDPOINT || "https://softcard.cc/api/discord/presence";
const secret = process.env.SOFTCARD_PRESENCE_SYNC_SECRET;
const watchedIds = new Set(
  (process.env.WATCHED_DISCORD_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

if (!token) throw new Error("Missing DISCORD_BOT_TOKEN.");
if (!secret) throw new Error("Missing SOFTCARD_PRESENCE_SYNC_SECRET.");

const activityNames = {
  [ActivityType.Playing]: "Playing",
  [ActivityType.Streaming]: "Streaming",
  [ActivityType.Listening]: "Listening to",
  [ActivityType.Watching]: "Watching",
  [ActivityType.Competing]: "Competing in",
};

const lastPayloadByUser = new Map();
const lastSentAtByUser = new Map();
const MIN_SYNC_MS = 15_000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
  ],
  partials: [Partials.GuildMember],
});

function pickActivity(presence) {
  return presence.activities.find((activity) => activity.type !== ActivityType.Custom) || presence.activities[0];
}

function activityImage(activity) {
  if (!activity?.assets) return "";
  return activity.assets.largeImageURL({ size: 128 }) || activity.assets.smallImageURL({ size: 128 }) || "";
}

function buildPayload(presence) {
  const activity = pickActivity(presence);
  const guild = presence.guild;
  const guildIcon = guild?.iconURL({ size: 128 }) || "";
  const status = presence.status || "offline";

  return {
    discordId: presence.userId,
    status,
    activity: activity
      ? {
          type: activityNames[activity.type] || "Active in",
          name: activity.name || "",
          details: activity.details || "",
          state: activity.state || "",
          image: activityImage(activity),
        }
      : {
          type: "",
          name: "",
          details: "",
          state: "",
          image: "",
        },
    server: guild
      ? {
          name: guild.name || "",
          status: activity ? `${status} in ${guild.name}` : `${status} in server`,
          icon: guildIcon,
        }
      : {
          name: "",
          status: status,
          icon: "",
        },
  };
}

function syncCachedPresences(force = false) {
  let count = 0;
  const seenUserIds = new Set();
  for (const guild of client.guilds.cache.values()) {
    for (const presence of guild.presences.cache.values()) {
      if (seenUserIds.has(presence.userId)) continue;
      seenUserIds.add(presence.userId);
      count += 1;
      syncPresence(presence, force).catch((error) => console.warn(error));
    }
  }
  return count;
}

async function syncPresence(presence, force = false) {
  if (!presence?.userId) return;
  if (watchedIds.size > 0 && !watchedIds.has(presence.userId)) return;

  const payload = buildPayload(presence);
  const key = JSON.stringify(payload);
  const previous = lastPayloadByUser.get(presence.userId);
  const lastSentAt = lastSentAtByUser.get(presence.userId) || 0;

  if (!force && previous === key) return;
  if (!force && Date.now() - lastSentAt < MIN_SYNC_MS) return;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: key,
  });

  lastSentAtByUser.set(presence.userId, Date.now());

  if (response.ok) {
    lastPayloadByUser.set(presence.userId, key);
    console.log(`Synced ${presence.userId}: ${payload.status}`);
    return;
  }

  const body = await response.text().catch(() => "");
  console.warn(`Softcard sync failed for ${presence.userId}: ${response.status} ${body}`);
}

client.once("ready", async () => {
  console.log(`Softcard presence bot online as ${client.user.tag}`);
  console.log(watchedIds.size > 0 ? `Watching ${watchedIds.size} configured Discord user IDs.` : "WATCHED_DISCORD_IDS is empty, syncing every visible presence.");
  console.log(`Initial cached presences: ${syncCachedPresences(true)}`);

  setInterval(() => {
    const count = syncCachedPresences(false);
    console.log(`Presence sweep checked ${count} cached presences.`);
  }, 60_000);
});

client.on("presenceUpdate", (_, newPresence) => {
  syncPresence(newPresence).catch((error) => console.warn(error));
});

client.on("guildMemberAdd", (member) => {
  if (watchedIds.size > 0 && !watchedIds.has(member.id)) return;
  setTimeout(() => {
    const presence = member.presence || member.guild.presences.cache.get(member.id);
    if (presence) {
      syncPresence(presence, true).catch((error) => console.warn(error));
    } else {
      console.log(`Member ${member.id} joined ${member.guild.name}, but Discord has not sent a presence for them yet.`);
    }
  }, 2_500);
});

client.on("error", (error) => console.error("Discord client error:", error));
client.on("warn", (message) => console.warn("Discord warning:", message));

client.login(token);
