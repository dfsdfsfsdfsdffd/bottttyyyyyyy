import {
  ActivityType,
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import Database from "better-sqlite3";

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

// --- PERSISTENT SQLITE DATABASE SETUP ---

const db = new Database("cats.db");

// Initialize tables if they don't exist
db.prepare(`
  CREATE TABLE IF NOT EXISTS server_setups (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT,
    message_count INTEGER DEFAULT 0
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS user_storage (
    user_id TEXT,
    cat_name TEXT,
    quantity INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, cat_name)
  )
`).run();

// --- CAT GAME DATABASE & CONFIGURATION ---

const CATS = [
  // Common
  { name: "Bruhcat", searchName: "10Bruhcat", emoji: "🐱", rarity: "Common", weight: 45 },
  { name: "Frfrcat", searchName: "12Frfrcat", emoji: "🐱", rarity: "Common", weight: 45 },
  { name: "Slappingcat", searchName: "1Slappingcat", emoji: "🐱", rarity: "Common", weight: 45 },
  { name: "Blebcat", searchName: "20Blebcat", emoji: "🐱", rarity: "Common", weight: 45 },
  { name: "Angrycat", searchName: "23Angrycat", emoji: "🐱", rarity: "Common", weight: 45 },
  { name: "Applecat", searchName: "24Applecat", emoji: "🐱", rarity: "Common", weight: 45 },
  { name: "Wavingcat", searchName: "27Wavingcat", emoji: "🐱", rarity: "Common", weight: 45 },
  { name: "Surprisedcat", searchName: "2Surprisedcat", emoji: "🐱", rarity: "Common", weight: 45 },
  { name: "uncannycat", searchName: "4uncannycat", emoji: "🐱", rarity: "Common", weight: 45 },
  { name: "Mancat", searchName: "5Mancat", emoji: "🐱", rarity: "Common", weight: 45 },
  { name: "Dumbcat", searchName: "7Dumbcat", emoji: "🐱", rarity: "Common", weight: 45 },
  
  // Uncommon
  { name: "Pointingcat", searchName: "14Pointingcat", emoji: "🐱", rarity: "Uncommon", weight: 25 },
  { name: "Pukingcat", searchName: "15Pukingcat", emoji: "🐱", rarity: "Uncommon", weight: 25 },
  { name: "Gentlemancat", searchName: "18Gentlemancat", emoji: "🐱", rarity: "Uncommon", weight: 25 },
  { name: "Goonercat", searchName: "22Goonercat", emoji: "🐱", rarity: "Uncommon", weight: 25 },
  { name: "Modelingcat", searchName: "29Modelingcat", emoji: "🐱", rarity: "Uncommon", weight: 25 },
  { name: "Sharkycat", searchName: "32Sharkycat", emoji: "🐱", rarity: "Uncommon", weight: 25 },
  { name: "Zombiecat", searchName: "6Zombiecat", emoji: "🐱", rarity: "Uncommon", weight: 25 },

  // Rare
  { name: "Sillycat", searchName: "17Sillycat", emoji: "🐱", rarity: "Rare", weight: 15 },
  { name: "Fatcat", searchName: "21Fatcat", emoji: "🐱", rarity: "Rare", weight: 15 },
  { name: "Thinkingcat", searchName: "25Thinkingcat", emoji: "🐱", rarity: "Rare", weight: 15 },
  { name: "Animecat", searchName: "31Animecat", emoji: "🐱", rarity: "Rare", weight: 15 },
  { name: "Freakycat", searchName: "33Freakycat", emoji: "🐱", rarity: "Rare", weight: 15 },
  { name: "Nerdcat", searchName: "3Nerdcat", emoji: "🐱", rarity: "Rare", weight: 15 },

  // Epic
  { name: "Bombcat", searchName: "19Bombcat", emoji: "🐱", rarity: "Epic", weight: 8 },
  { name: "Gamercat", searchName: "30Gamercat", emoji: "🐱", rarity: "Epic", weight: 8 },
  { name: "Moggingcat", searchName: "34Moggingcat", emoji: "🐱", rarity: "Epic", weight: 8 },

  // Legendary
  { name: "Dancingcat", searchName: "26Dancingcat", emoji: "🐱", rarity: "Legendary", weight: 2 },
  { name: "Evilcat", searchName: "28Evilcat", emoji: "🐱", rarity: "Legendary", weight: 2 },
  { name: "Suscat", searchName: "8Suscat", emoji: "🐱", rarity: "Legendary", weight: 2 }
];

const activeDrops = new Map(); // channelId -> active dropped cat object (restarts safely clear transient wild triggers)

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

  let rarityColor = "◽";
  if (cat.rarity === "Uncommon") rarityColor = "🔷";
  if (cat.rarity === "Rare") rarityColor = "🔶";
  if (cat.rarity === "Epic") rarityColor = "🔮";
  if (cat.rarity === "Legendary") rarityColor = "👑";

  await channel.send({
    content: `▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n✨ **A WILD CAT HAS APPEARED!** ✨\n\n${rarityColor} Rarity: **[${cat.rarity}]**\n🐈 Identity: ${cat.emoji} **${cat.name}**\n\n👉 *Quick! Type \`/pickup\` to add this cat to your storage collection!*\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`,
  });
}

function loadCustomServerEmojis() {
  let count = 0;
  client.guilds.cache.forEach((guild) => {
    guild.emojis.cache.forEach((emoji) => {
      const match = CATS.find((c) => c.searchName.toLowerCase() === emoji.name.toLowerCase());
      if (match) {
        match.emoji = `<:${emoji.name}:${emoji.id}>`;
        count++;
      }
    });
  });
  console.log(`Linked ${count} custom server cat emojis dynamically.`);
}

// Database Get/Set Helpers
function getServerSetup(guildId) {
  return db.prepare("SELECT * FROM server_setups WHERE guild_id = ?").get(guildId);
}

function saveServerChannel(guildId, channelId) {
  db.prepare(`
    INSERT INTO server_setups (guild_id, channel_id) 
    VALUES (?, ?) 
    ON CONFLICT(guild_id) DO UPDATE SET channel_id = excluded.channel_id
  `).run(guildId, channelId);
}

function incrementMessageCounter(guildId) {
  db.prepare(`
    INSERT INTO server_setups (guild_id, message_count) 
    VALUES (?, 1) 
    ON CONFLICT(guild_id) DO UPDATE SET message_count = message_count + 1
  `).run(guildId);
  const res = db.prepare("SELECT message_count FROM server_setups WHERE guild_id = ?").get(guildId);
  return res ? res.message_count : 1;
}

function resetMessageCounter(guildId) {
  db.prepare("UPDATE server_setups SET message_count = 0 WHERE guild_id = ?").run(guildId);
}

function getUserCatQuantity(userId, catName) {
  const row = db.prepare("SELECT quantity FROM user_storage WHERE user_id = ? AND cat_name = ?").get(userId, catName);
  return row ? row.quantity : 0;
}

function addUserCat(userId, catName, amount = 1) {
  db.prepare(`
    INSERT INTO user_storage (user_id, cat_name, quantity) 
    VALUES (?, ?, ?) 
    ON CONFLICT(user_id, cat_name) DO UPDATE SET quantity = quantity + excluded.quantity
  `).run(userId, catName, amount);
}

function removeUserCat(userId, catName, amount = 1) {
  db.prepare(`
    UPDATE user_storage SET quantity = quantity - ? 
    WHERE user_id = ? AND cat_name = ?
  `).run(amount, userId, catName);
}

function getUserInventory(userId) {
  return db.prepare("SELECT cat_name, quantity FROM user_storage WHERE user_id = ? AND quantity > 0").all(userId);
}

// --- INITIALIZE SLASH COMMANDS ON CLIENT READY ---

client.once("ready", async () => {
  console.log(`Softcard presence bot online as ${client.user.tag}`);
  console.log(watchedIds.size > 0 ? `Watching ${watchedIds.size} configured Discord user IDs.` : "WATCHED_DISCORD_IDS is empty, syncing every visible presence.");
  
  loadCustomServerEmojis();
  console.log(`Initial cached presences: ${syncCachedPresences(true)}`);

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
      .setDescription("Trade or gift your cats safely with another player")
      .addUserOption((option) => option.setName("user").setDescription("The user you want to trade with").setRequired(true))
      .addStringOption((option) => option.setName("your_cat").setDescription("Name of the cat you are giving").setRequired(true))
      .addStringOption((option) => option.setName("their_cat").setDescription("Name of the cat you want back (Leave blank or 'none' to gift)").setRequired(false)),
  ].map((command) => command.toJSON());

  const rest = new REST({ version: "10" }).setToken(token);
  try {
    console.log("Started refreshing application (/) commands.");
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error("Error refreshing slash commands:", error);
  }

  setInterval(() => {
    const count = syncCachedPresences(false);
    console.log(`Presence sweep checked ${count} cached presences.`);
  }, 60_000);

  // Trigger drops once every 10 minutes loop
  setInterval(() => {
    const rows = db.prepare("SELECT guild_id, channel_id FROM server_setups WHERE channel_id IS NOT NULL").all();
    for (const row of rows) {
      const guild = client.guilds.cache.get(row.guild_id);
      if (guild && row.channel_id) {
        triggerCatDrop(guild, row.channel_id).catch(console.error);
      }
    }
  }, 600_000); 
});

// --- INTERACTIONS & MESSAGE LISTENER ---

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  const guildId = message.guild.id;
  let setup = getServerSetup(guildId);
  let targetChannelId = setup?.channel_id;

  let currentCount = incrementMessageCounter(guildId);

  if (currentCount >= 100) {
    resetMessageCounter(guildId); 

    if (!targetChannelId) {
      const textChannels = message.guild.channels.cache.filter((c) => c.isTextBased());
      if (textChannels.size > 0) {
        const randomChannel = textChannels.random();
        targetChannelId = randomChannel.id;
        saveServerChannel(guildId, targetChannelId);
      }
    }

    if (targetChannelId) {
      await triggerCatDrop(message.guild, targetChannelId);
    }
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;

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

    saveServerChannel(guild.id, chosenChannel.id);
    return interaction.reply({ content: `✅ **Success!** Cat drops configured. Active drops will appear randomly or over time in <#${chosenChannel.id}>.` });
  }

  if (commandName === "pickup") {
    const activeCat = activeDrops.get(channelId);
    if (!activeCat) {
      return interaction.reply({ content: "❌ There is no wild cat running around in this channel right now!", ephemeral: true });
    }

    activeDrops.delete(channelId);
    addUserCat(user.id, activeCat.name, 1);

    return interaction.reply({
      content: `🎉 **${user.username}** quickly picked up the **[${activeCat.rarity}]** ${activeCat.emoji} **${activeCat.name}**! It has been safely added to your \`/catstorage\`.`,
    });
  }

  if (commandName === "catstorage") {
    const items = getUserInventory(user.id);

    if (items.length === 0) {
      return interaction.reply({ content: "📦 **Your Cat Storage vault is empty!** Chat active channels or secure drops via `/pickup` to fill it up.", ephemeral: true });
    }

    let responseText = `📬 ▬▬ **${user.username.toUpperCase()}'S CAT VAULT** ▬▬ 📬\n\n`;
    for (const item of items) {
      const reference = CATS.find((c) => c.name === item.cat_name);
      responseText += `${reference ? reference.emoji : "🐱"} **${item.cat_name}** × \`${item.quantity}\`  ↳  *[${reference ? reference.rarity : "Common"}]*\n`;
    }
    responseText += `\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`;

    return interaction.reply({ content: responseText });
  }

  if (commandName === "trade") {
    const targetUser = options.getUser("user");
    const yourCatInput = options.getString("your_cat").trim();
    const theirCatInput = options.getString("their_cat")?.trim() || "none";

    if (targetUser.id === user.id) {
      return interaction.reply({ content: "❌ You cannot initiate a trade proposal with yourself!", ephemeral: true });
    }
    if (targetUser.bot) {
      return interaction.reply({ content: "❌ Real cats don't build automated machinery. You can't trade with bots!", ephemeral: true });
    }

    const myMatch = CATS.find((c) => c.name.toLowerCase() === yourCatInput.toLowerCase());
    if (!myMatch || getUserCatQuantity(user.id, myMatch.name) <= 0) {
      return interaction.reply({ content: `❌ You do not own a cat named "${yourCatInput}" to trade away!`, ephemeral: true });
    }

    let theirMatch = null;
    const isGift = theirCatInput.toLowerCase() === "none";

    if (!isGift) {
      theirMatch = CATS.find((c) => c.name.toLowerCase() === theirCatInput.toLowerCase());
      if (!theirMatch || getUserCatQuantity(targetUser.id, theirMatch.name) <= 0) {
        return interaction.reply({ content: `❌ ${targetUser.username} doesn't own a cat named "${theirCatInput}" to fulfill their exchange!`, ephemeral: true });
      }
    }

    const acceptButtonId = `confirm_trade_${interaction.id}`;
    const cancelButtonId = `cancel_trade_${interaction.id}`;

    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(acceptButtonId).setLabel("Accept Trade").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(cancelButtonId).setLabel("Decline / Cancel").setStyle(ButtonStyle.Danger)
    );

    let displayString = `🤝 ▬▬ **SECURE TRADE OFFER** ▬▬ 🤝\n\n` +
                        `👤 **Sender:** ${user}\n` +
                        `📤 **Offering:** ${myMatch.emoji} **${myMatch.name}** (\`${myMatch.rarity}\`)\n\n` +
                        `👤 **Receiver:** ${targetUser}\n`;

    if (isGift) {
      displayString += `📥 **Receiving:** 🎁 *Nothing (This is a gift/one-way exchange!)*\n\n`;
    } else {
      displayString += `📥 **Requesting:** ${theirMatch.emoji} **${theirMatch.name}** (\`${theirMatch.rarity}\`)\n\n`;
    }

    displayString += `⚠️ *Both users must have valid inventory amounts. ${targetUser}, click below to confirm exchange securely.*`;

    const offerMessage = await interaction.reply({
      content: displayString,
      components: [actionRow],
      fetchReply: true
    });

    const buttonCollector = offerMessage.createMessageComponentCollector({
      time: 60_000,
    });

    let senderConfirmed = false;
    let receiverConfirmed = false;

    buttonCollector.on("collect", async (btnInteraction) => {
      if (btnInteraction.customId === cancelButtonId) {
        if (btnInteraction.user.id !== user.id && btnInteraction.user.id !== targetUser.id) {
          return btnInteraction.reply({ content: "❌ You are not involved in this trade deal.", ephemeral: true });
        }
        buttonCollector.stop("cancelled");
        return btnInteraction.reply({ content: `❌ Trade cancelled by ${btnInteraction.user}.` });
      }

      if (btnInteraction.customId === acceptButtonId) {
        if (btnInteraction.user.id === user.id) {
          senderConfirmed = true;
          await btnInteraction.reply({ content: "⏳ You accepted. Waiting on your partner...", ephemeral: true });
        } else if (btnInteraction.user.id === targetUser.id) {
          receiverConfirmed = true;
          await btnInteraction.reply({ content: "⏳ You accepted. Processing data verification...", ephemeral: true });
        } else {
          return btnInteraction.reply({ content: "❌ You are not a party inside this transaction.", ephemeral: true });
        }

        const structuralConditionsMet = isGift ? receiverConfirmed : (senderConfirmed && receiverConfirmed);
        
        if (structuralConditionsMet) {
          buttonCollector.stop("completed");
        }
      }
    });

    buttonCollector.on("end", async (_, reason) => {
      const disabledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(acceptButtonId).setLabel("Accept Trade").setStyle(ButtonStyle.Success).setDisabled(true),
        new ButtonBuilder().setCustomId(cancelButtonId).setLabel("Decline / Cancel").setStyle(ButtonStyle.Danger).setDisabled(true)
      );

      if (reason === "completed") {
        // Fetch fresh database balances right before transaction processing
        const senderHasCat = getUserCatQuantity(user.id, myMatch.name) > 0;
        const receiverHasCat = isGift || getUserCatQuantity(targetUser.id, theirMatch.name) > 0;

        if (senderHasCat && receiverHasCat) {
          removeUserCat(user.id, myMatch.name, 1);
          
          if (isGift) {
            addUserCat(targetUser.id, myMatch.name, 1);
            await interaction.editReply({
              content: `🎁 **GIFT TRANSACTION COMPLETE!**\n\n${user} gifted ${myMatch.emoji} **${myMatch.name}** directly to ${targetUser}!`,
              components: [disabledRow]
            });
          } else {
            addUserCat(user.id, theirMatch.name, 1);
            removeUserCat(targetUser.id, theirMatch.name, 1);
            addUserCat(targetUser.id, myMatch.name, 1);

            await interaction.editReply({
              content: `✅ **TRADE TRANSACTION SUCCESSFUL!**\n\n✨ ${user} accepted ${theirMatch.emoji} **${theirMatch.name}**\n✨ ${targetUser} accepted ${myMatch.emoji} **${myMatch.name}**`,
              components: [disabledRow]
            });
          }
        } else {
          await interaction.editReply({ content: "❌ **Transaction Aborted:** Inventory values modified or no longer sufficient before clicking confirmation.", components: [disabledRow] });
        }
      } else if (reason === "time") {
        await interaction.editReply({ content: `⏳ **Trade Expired:** 60-second limit reached before confirmations filed.`, components: [disabledRow] }).catch(() => {});
      } else {
        await interaction.editReply({ components: [disabledRow] }).catch(() => {});
      }
    });
    return;
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