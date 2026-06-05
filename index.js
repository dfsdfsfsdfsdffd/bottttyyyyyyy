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
import { createClient } from "@supabase/supabase-js";

const token = process.env.DISCORD_BOT_TOKEN;
const endpoint = process.env.SOFTCARD_PRESENCE_ENDPOINT || "https://softcard.cc/api/discord/presence";
const secret = process.env.SOFTCARD_PRESENCE_SYNC_SECRET;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

const watchedIds = new Set(
  (process.env.WATCHED_DISCORD_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

if (!token) throw new Error("Missing DISCORD_BOT_TOKEN.");
if (!secret) throw new Error("Missing SOFTCARD_PRESENCE_SYNC_SECRET.");
if (!supabaseUrl || !supabaseKey) throw new Error("Missing SUPABASE_URL or SUPABASE_KEY.");

// Initialize Supabase Client with explicitly configured global fetch to prevent container environment errors
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
});

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

// --- CAT GAME CONFIGURATION ---

const CATS = [
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
  
  { name: "Pointingcat", searchName: "14Pointingcat", emoji: "🐱", rarity: "Uncommon", weight: 25 },
  { name: "Pukingcat", searchName: "15Pukingcat", emoji: "🐱", rarity: "Uncommon", weight: 25 },
  { name: "Gentlemancat", searchName: "18Gentlemancat", emoji: "🐱", rarity: "Uncommon", weight: 25 },
  { name: "Goonercat", searchName: "22Goonercat", emoji: "🐱", rarity: "Uncommon", weight: 25 },
  { name: "Modelingcat", searchName: "29Modelingcat", emoji: "🐱", rarity: "Uncommon", weight: 25 },
  { name: "Sharkycat", searchName: "32Sharkycat", emoji: "🐱", rarity: "Uncommon", weight: 25 },
  { name: "Zombiecat", searchName: "6Zombiecat", emoji: "🐱", rarity: "Uncommon", weight: 25 },

  { name: "Sillycat", searchName: "17Sillycat", emoji: "🐱", rarity: "Rare", weight: 15 },
  { name: "Fatcat", searchName: "21Fatcat", emoji: "🐱", rarity: "Rare", weight: 15 },
  { name: "Thinkingcat", searchName: "25Thinkingcat", emoji: "🐱", rarity: "Rare", weight: 15 },
  { name: "Animecat", searchName: "31Animecat", emoji: "🐱", rarity: "Rare", weight: 15 },
  { name: "Freakycat", searchName: "33Freakycat", emoji: "🐱", rarity: "Rare", weight: 15 },
  { name: "Nerdcat", searchName: "3Nerdcat", emoji: "🐱", rarity: "Rare", weight: 15 },

  { name: "Bombcat", searchName: "19Bombcat", emoji: "🐱", rarity: "Epic", weight: 8 },
  { name: "Gamercat", searchName: "30Gamercat", emoji: "🐱", rarity: "Epic", weight: 8 },
  { name: "Moggingcat", searchName: "34Moggingcat", emoji: "🐱", rarity: "Epic", weight: 8 },

  { name: "Dancingcat", searchName: "26Dancingcat", emoji: "🐱", rarity: "Legendary", weight: 2 },
  { name: "Evilcat", searchName: "28Evilcat", emoji: "🐱", rarity: "Legendary", weight: 2 },
  { name: "Suscat", searchName: "8Suscat", emoji: "🐱", rarity: "Legendary", weight: 2 }
];

const activeDrops = new Map();

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
      : { type: "", name: "", details: "", state: "", image: "" },
    server: guild
      ? { name: guild.name || "", status: activity ? `${status} in ${guild.name}` : `${status} in server`, icon: guildIcon }
      : { name: "", status: status, icon: "" },
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

  try {
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
  } catch (err) {
    console.error(`Failed connecting to presence API endpoint for ${presence.userId}:`, err.message);
  }
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

// --- SUPABASE DATABASE GET/SET HELPERS ---

async function getServerSetup(guildId) {
  const { data, error } = await supabase.from("server_setups").select("*").eq("guild_id", guildId).maybeSingle();
  if (error) console.error("Database query error [getServerSetup]:", error.message);
  return data;
}

async function saveServerChannel(guildId, channelId) {
  const { error } = await supabase.from("server_setups").upsert({ guild_id: guildId, channel_id: channelId }, { onConflict: "guild_id" });
  if (error) console.error("Database write error [saveServerChannel]:", error.message);
}

async function incrementMessageCounter(guildId) {
  const setup = await getServerSetup(guildId);
  const nextCount = (setup?.message_count || 0) + 1;
  const { error } = await supabase.from("server_setups").upsert({ guild_id: guildId, message_count: nextCount }, { onConflict: "guild_id" });
  if (error) console.error("Database write error [incrementMessageCounter]:", error.message);
  return nextCount;
}

async function resetMessageCounter(guildId) {
  const { error } = await supabase.from("server_setups").upsert({ guild_id: guildId, message_count: 0 }, { onConflict: "guild_id" });
  if (error) console.error("Database write error [resetMessageCounter]:", error.message);
}

async function getUserCatQuantity(userId, catName) {
  const { data, error } = await supabase.from("user_storage").select("quantity").eq("user_id", userId).eq("cat_name", catName).maybeSingle();
  if (error) console.error("Database query error [getUserCatQuantity]:", error.message);
  return data ? data.quantity : 0;
}

async function addUserCat(userId, catName, amount = 1) {
  const currentQuantity = await getUserCatQuantity(userId, catName);
  const { error } = await supabase.from("user_storage").upsert({ user_id: userId, cat_name: catName, quantity: currentQuantity + amount }, { onConflict: "user_id,cat_name" });
  if (error) console.error("Database write error [addUserCat]:", error.message);
}

async function removeUserCat(userId, catName, amount = 1) {
  const currentQuantity = await getUserCatQuantity(userId, catName);
  const { error } = await supabase.from("user_storage").upsert({ user_id: userId, cat_name: catName, quantity: Math.max(0, currentQuantity - amount) }, { onConflict: "user_id,cat_name" });
  if (error) console.error("Database write error [removeUserCat]:", error.message);
}

async function getUserInventory(userId) {
  const { data, error } = await supabase.from("user_storage").select("cat_name, quantity").eq("user_id", userId).gt("quantity", 0);
  if (error) console.error("Database query error [getUserInventory]:", error.message);
  return data || [];
}

// --- INITIALIZE SLASH COMMANDS ON CLIENT READY ---

client.once("ready", async () => {
  console.log(`Softcard presence bot online as ${client.user.tag}`);
  loadCustomServerEmojis();
  console.log(`Initial cached presences: ${syncCachedPresences(true)}`);

  const commands = [
    new SlashCommandBuilder()
      .setName("serversetup")
      .setDescription("Configure the spawn channel for cats")
      .addChannelOption((option) => option.setName("channel").setDescription("The channel where cats drop")),
    new SlashCommandBuilder().setName("pickup").setDescription("Pick up an active cat drop in this channel"),
    new SlashCommandBuilder().setName("catstorage").setDescription("View your current inventory of caught cats"),
    new SlashCommandBuilder()
      .setName("trade")
      .setDescription("Trade or gift your cats safely with another player")
      .addUserOption((option) => option.setName("user").setDescription("The user you want to trade with").setRequired(true))
      .addStringOption((option) => option.setName("your_cat").setDescription("Name of the cat you are giving").setRequired(true))
      .addStringOption((option) => option.setName("their_cat").setDescription("Name of the cat you want back").setRequired(false)),
  ].map((command) => command.toJSON());

  const rest = new REST({ version: "10" }).setToken(token);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error("Error refreshing slash commands:", error);
  }

  setInterval(() => {
    syncCachedPresences(false);
  }, 60_000);

  // Trigger timed loops every 10 minutes
  setInterval(async () => {
    try {
      const { data: rows } = await supabase.from("server_setups").select("guild_id, channel_id").not("channel_id", "is", null);
      if (!rows) return;
      for (const row of rows) {
        const guild = client.guilds.cache.get(row.guild_id);
        if (guild && row.channel_id) {
          triggerCatDrop(guild, row.channel_id).catch(console.error);
        }
      }
    } catch (err) {
      console.error("Error in drop interval loop:", err.message);
    }
  }, 600_000); 
});

// --- INTERACTIONS & MESSAGE LISTENER ---

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  const guildId = message.guild.id;
  let setup = await getServerSetup(guildId);
  let targetChannelId = setup?.channel_id;

  let currentCount = await incrementMessageCounter(guildId);

  if (currentCount >= 100) {
    await resetMessageCounter(guildId); 

    if (!targetChannelId) {
      const textChannels = message.guild.channels.cache.filter((c) => c.isTextBased());
      if (textChannels.size > 0) {
        const randomChannel = textChannels.random();
        targetChannelId = randomChannel.id;
        await saveServerChannel(guildId, targetChannelId);
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
      if (textChannels.size === 0) return interaction.reply({ content: "❌ No text channels found!", ephemeral: true });
      chosenChannel = textChannels.random();
    }

    await saveServerChannel(guild.id, chosenChannel.id);
    return interaction.reply({ content: `✅ **Success!** Cat drops configured in <#${chosenChannel.id}>.` });
  }

  if (commandName === "pickup") {
    const activeCat = activeDrops.get(channelId);
    if (!activeCat) return interaction.reply({ content: "❌ There is no wild cat running around in this channel!", ephemeral: true });

    activeDrops.delete(channelId);
    await addUserCat(user.id, activeCat.name, 1);

    return interaction.reply({
      content: `🎉 **${user.username}** picked up the **[${activeCat.rarity}]** ${activeCat.emoji} **${activeCat.name}**! Check your \`/catstorage\`.`,
    });
  }

  if (commandName === "catstorage") {
    await interaction.deferReply({ ephemeral: true });
    const items = await getUserInventory(user.id);

    if (items.length === 0) return interaction.editReply({ content: "📦 **Your Cat Storage vault is empty!**" });

    let responseText = `📬 ▬▬ **${user.username.toUpperCase()}'S CAT VAULT** ▬▬ 📬\n\n`;
    for (const item of items) {
      const reference = CATS.find((c) => c.name === item.cat_name);
      responseText += `${reference ? reference.emoji : "🐱"} **${item.cat_name}** × \`${item.quantity}\`  ↳  *[${reference ? reference.rarity : "Common"}]*\n`;
    }
    responseText += `\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`;

    return interaction.editReply({ content: responseText });
  }

  if (commandName === "trade") {
    const targetUser = options.getUser("user");
    const yourCatInput = options.getString("your_cat").trim();
    const theirCatInput = options.getString("their_cat")?.trim() || "none";

    if (targetUser.id === user.id) return interaction.reply({ content: "❌ You cannot trade with yourself!", ephemeral: true });
    if (targetUser.bot) return interaction.reply({ content: "❌ You can't trade with bots!", ephemeral: true });

    const myMatch = CATS.find((c) => c.name.toLowerCase() === yourCatInput.toLowerCase());
    const myQuantity = myMatch ? await getUserCatQuantity(user.id, myMatch.name) : 0;
    if (!myMatch || myQuantity <= 0) return interaction.reply({ content: `❌ You do not own a cat named "${yourCatInput}"!`, ephemeral: true });

    let theirMatch = null;
    const isGift = theirCatInput.toLowerCase() === "none";

    if (!isGift) {
      theirMatch = CATS.find((c) => c.name.toLowerCase() === theirCatInput.toLowerCase());
      const theirQuantity = theirMatch ? await getUserCatQuantity(targetUser.id, theirMatch.name) : 0;
      if (!theirMatch || theirQuantity <= 0) return interaction.reply({ content: `❌ ${targetUser.username} doesn't own a cat named "${theirCatInput}"!`, ephemeral: true });
    }

    const acceptButtonId = `confirm_trade_${interaction.id}`;
    const cancelButtonId = `cancel_trade_${interaction.id}`;

    const actionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(acceptButtonId).setLabel("Accept Trade").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(cancelButtonId).setLabel("Decline / Cancel").setStyle(ButtonStyle.Danger)
    );

    let displayString = `🤝 ▬▬ **SECURE TRADE OFFER** ▬▬ 🤝\n\n👤 **Sender:** ${user}\n📤 **Offering:** ${myMatch.emoji} **${myMatch.name}**\n\n👤 **Receiver:** ${targetUser}\n`;
    displayString += isGift ? `📥 **Receiving:** 🎁 *Nothing (Gift)*\n\n` : `📥 **Requesting:** ${theirMatch.emoji} **${theirMatch.name}**\n\n`;

    const offerMessage = await interaction.reply({ content: displayString, components: [actionRow], fetchReply: true });
    const buttonCollector = offerMessage.createMessageComponentCollector({ time: 60_000 });

    let senderConfirmed = false;
    let receiverConfirmed = false;

    buttonCollector.on("collect", async (btnInteraction) => {
      if (btnInteraction.customId === cancelButtonId) {
        if (btnInteraction.user.id !== user.id && btnInteraction.user.id !== targetUser.id) return btnInteraction.reply({ content: "❌ Not your trade.", ephemeral: true });
        buttonCollector.stop("cancelled");
        return btnInteraction.reply({ content: `❌ Trade cancelled.` });
      }

      if (btnInteraction.customId === acceptButtonId) {
        if (btnInteraction.user.id === user.id) {
          senderConfirmed = true;
          await btnInteraction.reply({ content: "⏳ Accepted. Waiting on partner...", ephemeral: true });
        } else if (btnInteraction.user.id === targetUser.id) {
          receiverConfirmed = true;
          await btnInteraction.reply({ content: "⏳ Accepted. Processing...", ephemeral: true });
        } else {
          return btnInteraction.reply({ content: "❌ Not your trade.", ephemeral: true });
        }

        if (isGift ? receiverConfirmed : (senderConfirmed && receiverConfirmed)) {
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
        const senderHasCat = (await getUserCatQuantity(user.id, myMatch.name)) > 0;
        const receiverHasCat = isGift || (await getUserCatQuantity(targetUser.id, theirMatch.name)) > 0;

        if (senderHasCat && receiverHasCat) {
          await removeUserCat(user.id, myMatch.name, 1);
          if (isGift) {
            await addUserCat(targetUser.id, myMatch.name, 1);
            await interaction.editReply({ content: `🎁 **GIFT COMPLETE!**\n\n${user} gifted ${myMatch.emoji} **${myMatch.name}** to ${targetUser}!`, components: [disabledRow] });
          } else {
            await addUserCat(user.id, theirMatch.name, 1);
            await removeUserCat(targetUser.id, theirMatch.name, 1);
            await addUserCat(targetUser.id, myMatch.name, 1);
            await interaction.editReply({ content: `✅ **TRADE SUCCESSFUL!**\n\n✨ Swapped successfully!`, components: [disabledRow] });
          }
        } else {
          await interaction.editReply({ content: "❌ **Transaction Aborted:** Items are no longer available.", components: [disabledRow] });
        }
      } else {
        await interaction.editReply({ components: [disabledRow] }).catch(() => {});
      }
    });
  }
});

client.on("presenceUpdate", (_, newPresence) => {
  syncPresence(newPresence).catch((error) => console.warn(error));
});

client.on("error", (error) => console.error("Discord client error:", error));
client.login(token);