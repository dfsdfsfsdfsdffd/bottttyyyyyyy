import {
  ActivityType,
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
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

// --- CAT GAME DATABASE & CONFIGURATION ---

const CATS = [
  // Common
  { name: "Bruhcat", emoji: "<:10Bruhcat:123456789012345678>", rarity: "Common", weight: 45 },
  { name: "Frfrcat", emoji: "<:12Frfrcat:123456789012345678>", rarity: "Common", weight: 45 },
  { name: "Slappingcat", emoji: "<:1Slappingcat:123456789012345678>", rarity: "Common", weight: 45 },
  { name: "Blebcat", emoji: "<:20Blebcat:123456789012345678>", rarity: "Common", weight: 45 },
  { name: "Angrycat", emoji: "<:23Angrycat:123456789012345678>", rarity: "Common", weight: 45 },
  { name: "Applecat", emoji: "<:24Applecat:123456789012345678>", rarity: "Common", weight: 45 },
  { name: "Wavingcat", emoji: "<:27Wavingcat:123456789012345678>", rarity: "Common", weight: 45 },
  { name: "Surprisedcat", emoji: "<:2Surprisedcat:123456789012345678>", rarity: "Common", weight: 45 },
  { name: "uncannycat", emoji: "<:4uncannycat:123456789012345678>", rarity: "Common", weight: 45 },
  { name: "Mancat", emoji: "<:5Mancat:123456789012345678>", rarity: "Common", weight: 45 },
  { name: "Dumbcat", emoji: "<:7Dumbcat:123456789012345678>", rarity: "Common", weight: 45 },
  
  // Uncommon
  { name: "Pointingcat", emoji: "<:14Pointingcat:123456789012345678>", rarity: "Uncommon", weight: 25 },
  { name: "Pukingcat", emoji: "<:15Pukingcat:123456789012345678>", rarity: "Uncommon", weight: 25 },
  { name: "Gentlemancat", emoji: "<:18Gentlemancat:123456789012345678>", rarity: "Uncommon", weight: 25 },
  { name: "Goonercat", emoji: "<:22Goonercat:123456789012345678>", rarity: "Uncommon", weight: 25 },
  { name: "Modelingcat", emoji: "<:29Modelingcat:123456789012345678>", rarity: "Uncommon", weight: 25 },
  { name: "Sharkycat", emoji: "<:32Sharkycat:123456789012345678>", rarity: "Uncommon", weight: 25 },
  { name: "Zombiecat", emoji: "<:6Zombiecat:123456789012345678>", rarity: "Uncommon", weight: 25 },

  // Rare
  { name: "Sillycat", emoji: "<:17Sillycat:123456789012345678>", rarity: "Rare", weight: 15 },
  { name: "Fatcat", emoji: "<:21Fatcat:123456789012345678>", rarity: "Rare", weight: 15 },
  { name: "Thinkingcat", emoji: "<:25Thinkingcat:123456789012345678>", rarity: "Rare", weight: 15 },
  { name: "Animecat", emoji: "<:31Animecat:123456789012345678>", rarity: "Rare", weight: 15 },
  { name: "Freakycat", emoji: "<:33Freakycat:123456789012345678>", rarity: "Rare", weight: 15 },
  { name: "Nerdcat", emoji: "<:33Freakycat:123456789012345678>", rarity: "Rare", weight: 15 },

  // Epic
  { name: "Bombcat", emoji: "<:19Bombcat:123456789012345678>", rarity: "Epic", weight: 8 },
  { name: "Gamercat", emoji: "<:30Gamercat:123456789012345678>", rarity: "Epic", weight: 8 },
  { name: "Moggingcat", emoji: "<:34Moggingcat:123456789012345678>", rarity: "Epic", weight: 8 },

  // Legendary
  { name: "Dancingcat", emoji: "<:26Dancingcat:123456789012345678>", rarity: "Legendary", weight: 2 },
  { name: "Evilcat", emoji: "<:28Evilcat:123456789012345678>", rarity: "Legendary", weight: 2 },
  { name: "Suscat", emoji: "<:8Suscat:123456789012345678>", rarity: "Legendary", weight: 2 }
];

// Note: Replace the '123456789012345678' parts inside the custom emojis above with your actual server emoji IDs.

// State variables for tracking game logic
const serverSetups = new Map(); // guildId -> channelId
const messageCounters = new Map(); // guildId -> count
const activeDrops = new Map(); // channelId -> active dropped cat object
const userStorage = new Map(); // userId -> { catName: quantity }
const activeTrades = new Map(); // messageId -> trade details object

// --- END OF CAT GAME CONFIGURATION ---

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
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

// --- HELPER FUNCTIONS FOR GAMEPLAY ---

function chooseRandomCat() {
  const totalWeight = CATS.reduce((sum, cat) => sum + cat.weight, 0);
  let random = Math.random() * totalWeight;
  for (const cat of CATS) {
    if (random < cat.weight) return cat;
    random -= cat.weight;
  }
  return CATS[0];
}

async function triggerCatDrop(guild, channelId) {
  const channel = guild.channels.cache.get(channelId);
  if (!channel) return;

  const cat = chooseRandomCat();
  activeDrops.set(channelId, cat);

  await channel.send({
    content: `🐱 **A WILD CAT HAS APPEARED!** 🐱\n\nA **[${cat.rarity}]** ${cat.emoji} **${cat.name}** has dropped!\nType \`/pickup\` quickly to claim it!`,
  });
}

// --- INITIALIZE SLASH COMMANDS ON CLIENT READY ---

client.once("ready", async () => {
  console.log(`Softcard presence bot online as ${client.user.tag}`);
  console.log(watchedIds.size > 0 ? `Watching ${watchedIds.size} configured Discord user IDs.` : "WATCHED_DISCORD_IDS is empty, syncing every visible presence.");
  console.log(`Initial cached presences: ${syncCachedPresences(true)}`);

  // Registering Slash Commands Globally
  const commands = [
    new SlashCommandBuilder()
      .setName("serversetup")
      .setDescription("Configure the spawn channel for cats")
      .addChannelOption((option) =>
        option.setName("channel").setDescription("The channel where cats drop (Leave empty for a random text channel)")
      ),
    new SlashCommandBuilder()
      .setName("pickup")
      .setDescription("Pick up an active cat drop in this channel"),
    new SlashCommandBuilder()
      .setName("catstorage")
      .setDescription("View your current inventory of caught cats"),
    new SlashCommandBuilder()
      .setName("trade")
      .setDescription("Trade your cats with another player")
      .addUserOption((option) => option.setName("user").setDescription("The user you want to trade with").setRequired(true))
      .addStringOption((option) => option.setName("your_cat").setDescription("Name of the cat you are giving").setRequired(true))
      .addStringOption((option) => option.setName("their_cat").setDescription("Name of the cat you want in return").setRequired(true)),
  ].map((command) => command.toJSON());

  const rest = new REST({ version: "10" }).setToken(token);
  try {
    console.log("Started refreshing application (/) commands.");
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error("Error refreshing slash commands:", error);
  }

  // Sweep task for original code
  setInterval(() => {
    const count = syncCachedPresences(false);
    console.log(`Presence sweep checked ${count} cached presences.`);
  }, 60_000);

  // Hourly passive cat spawn loops
  setInterval(() => {
    for (const [guildId, channelId] of serverSetups.entries()) {
      const guild = client.guilds.cache.get(guildId);
      if (guild) {
        triggerCatDrop(guild, channelId).catch(console.error);
      }
    }
  }, 3_600_000); // 1 hour loop
});

// --- INTERACTIONS & MESSAGE LISTENER ---

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  const guildId = message.guild.id;
  let targetChannelId = serverSetups.get(guildId);

  // If the server setup has not run or was configured implicitly, we track messages anyway
  let currentCount = (messageCounters.get(guildId) || 0) + 1;
  messageCounters.set(guildId, currentCount);

  if (currentCount >= 100) {
    messageCounters.set(guildId, 0); // resets count

    // If channel wasn't configured, choose a random viable text channel
    if (!targetChannelId) {
      const textChannels = message.guild.channels.cache.filter((c) => c.isTextBased());
      if (textChannels.size > 0) {
        const randomChannel = textChannels.random();
        targetChannelId = randomChannel.id;
        serverSetups.set(guildId, targetChannelId);
      }
    }

    if (targetChannelId) {
      await triggerCatDrop(message.guild, targetChannelId);
    }
  }
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isCommand()) {
    const { commandName, options, guild, user, channelId } = interaction;

    if (commandName === "serversetup") {
      let chosenChannel = options.getChannel("channel");

      if (!chosenChannel) {
        const textChannels = guild.channels.cache.filter((c) => c.isTextBased());
        if (textChannels.size === 0) {
          return interaction.reply({ content: "❌ No text channels found to set up!", ephemeral: true });
        }
        chosenChannel = textChannels.random();
      }

      serverSetups.set(guild.id, chosenChannel.id);
      return interaction.reply({ content: `✅ Cat drops configured! Drops will occur in <#${chosenChannel.id}>.` });
    }

    if (commandName === "pickup") {
      const activeCat = activeDrops.get(channelId);
      if (!activeCat) {
        return interaction.reply({ content: "❌ There is no wild cat to pick up in this channel right now!", ephemeral: true });
      }

      // Clear drop so only one person catches it
      activeDrops.delete(channelId);

      // Save to user storage
      if (!userStorage.has(user.id)) {
        userStorage.set(user.id, {});
      }
      const inventory = userStorage.get(user.id);
      inventory[activeCat.name] = (inventory[activeCat.name] || 0) + 1;

      return interaction.reply({
        content: `🎉 **${user.username}** picked up the **[${activeCat.rarity}]** ${activeCat.emoji} **${activeCat.name}**! It has been safely stored in their \`/catstorage\`.`,
      });
    }

    if (commandName === "catstorage") {
      const inventory = userStorage.get(user.id) || {};
      const items = Object.entries(inventory).filter(([_, qty]) => qty > 0);

      if (items.length === 0) {
        return interaction.reply({ content: "🐱 Your storage is empty! Chat more or use `/pickup` when a cat drops.", ephemeral: true });
      }

      let responseText = `📬 **${user.username}'s Cat Storage:**\n\n`;
      for (const [name, qty] of items) {
        const reference = CATS.find((c) => c.name === name);
        responseText += `${reference ? reference.emoji : "🐱"} **${name}** — x${qty} (\`${reference ? reference.rarity : "Unknown"}\`)\n`;
      }

      return interaction.reply({ content: responseText });
    }

    if (commandName === "trade") {
      const targetUser = options.getUser("user");
      const yourCatInput = options.getString("your_cat").trim();
      const theirCatInput = options.getString("their_cat").trim();

      if (targetUser.id === user.id) {
        return interaction.reply({ content: "❌ You cannot trade with yourself!", ephemeral: true });
      }
      if (targetUser.bot) {
        return interaction.reply({ content: "❌ You cannot trade with bots!", ephemeral: true });
      }

      const myInventory = userStorage.get(user.id) || {};
      const targetInventory = userStorage.get(targetUser.id) || {};

      const myMatch = CATS.find((c) => c.name.toLowerCase() === yourCatInput.toLowerCase());
      const theirMatch = CATS.find((c) => c.name.toLowerCase() === theirCatInput.toLowerCase());

      if (!myMatch || !myInventory[myMatch.name] || myInventory[myMatch.name] <= 0) {
        return interaction.reply({ content: `❌ You do not own a cat named "${yourCatInput}" to trade away!`, ephemeral: true });
      }
      if (!theirMatch || !targetInventory[theirMatch.name] || targetInventory[theirMatch.name] <= 0) {
        return interaction.reply({ content: `❌ ${targetUser.username} does not own a cat named "${theirCatInput}"!`, ephemeral: true });
      }

      const replyMessage = await interaction.reply({
        content: `🤝 **Trade Proposal!**\n\n${user} wants to trade their ${myMatch.emoji} **${myMatch.name}** for ${targetUser}'s ${theirMatch.emoji} **${theirMatch.name}**.\n\n${targetUser}, type **\`confirm\`** in chat within 60 seconds to accept this trade.`,
        fetchReply: true,
      });

      const filter = (m) => m.author.id === targetUser.id && m.content.toLowerCase() === "confirm";
      const collector = interaction.channel.createMessageCollector({ filter, time: 60_000, max: 1 });

      collector.on("collect", async () => {
        // Double check balances directly inside completion lock
        if (myInventory[myMatch.name] > 0 && targetInventory[theirMatch.name] > 0) {
          myInventory[myMatch.name] -= 1;
          myInventory[theirMatch.name] = (myInventory[theirMatch.name] || 0) + 1;

          targetInventory[theirMatch.name] -= 1;
          targetInventory[myMatch.name] = (targetInventory[myMatch.name] || 0) + 1;

          await interaction.followUp({
            content: `✅ **Trade Successful!**\n\n${user} received ${theirMatch.emoji} **${theirMatch.name}**\n${targetUser} received ${myMatch.emoji} **${myMatch.name}**!`,
          });
        } else {
          await interaction.followUp({ content: "❌ Trade failed. Inventories changed before completion." });
        }
      });

      collector.on("end", (_, reason) => {
        if (reason === "time") {
          interaction.followUp({ content: `⏳ Trade offer from ${user} to ${targetUser} expired.` }).catch(() => {});
        }
      });
      return;
    }
  }
});

// --- CORE HANDLERS CONTINUED ---

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