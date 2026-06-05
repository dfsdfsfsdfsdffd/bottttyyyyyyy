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
import fs from "fs";
import path from "path";
import zlib from "zlib"; // Built-in Node tool for data compression ops

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

// --- GAME DATA LOCAL PERSISTENCE LAYER ---
const STORAGE_DIR = "./data";
const STORAGE_FILE = path.join(STORAGE_DIR, "storage.json");
const PFP_OUTPUT_DIR = path.join(STORAGE_DIR, "scraped_pfps");

function initStorage() {
  try {
    if (!fs.existsSync(STORAGE_DIR)) {
      fs.mkdirSync(STORAGE_DIR, { recursive: true });
    }
    if (!fs.existsSync(PFP_OUTPUT_DIR)) {
      fs.mkdirSync(PFP_OUTPUT_DIR, { recursive: true });
    }
    if (!fs.existsSync(STORAGE_FILE)) {
      fs.writeFileSync(STORAGE_FILE, JSON.stringify({ serverSetups: {}, serverMessageCounters: {}, userStorage: {} }, null, 2), "utf8");
    }
  } catch (error) {
    console.error("Failed to initialize storage folders:", error);
  }
}

function loadData() {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      const data = fs.readFileSync(STORAGE_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (error) {
    console.error("Error reading data from storage file, returning safe defaults:", error);
  }
  return { serverSetups: {}, serverMessageCounters: {}, userStorage: {} };
}

function saveData(data) {
  try {
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (error) {
    console.error("Error writing data state to storage file:", error);
  }
}

initStorage();

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

// --- PERSISTENT STORAGE MAP IMPLEMENTATIONS ---
function getUserCatQuantity(userId, catName) {
  const state = loadData();
  const vault = state.userStorage[userId];
  if (!vault) return 0;
  return vault[catName] || 0;
}

function addUserCat(userId, catName, amount = 1) {
  const state = loadData();
  if (!state.userStorage[userId]) {
    state.userStorage[userId] = {};
  }
  state.userStorage[userId][catName] = (state.userStorage[userId][catName] || 0) + amount;
  saveData(state);
}

function removeUserCat(userId, catName, amount = 1) {
  const state = loadData();
  const vault = state.userStorage[userId];
  if (!vault || !vault[catName]) return;
  
  vault[catName] = Math.max(0, vault[catName] - amount);
  if (vault[catName] === 0) delete vault[catName];
  saveData(state);
}

function getUserInventory(userId) {
  const state = loadData();
  const vault = state.userStorage[userId] || {};
  return Object.entries(vault).map(([cat_name, quantity]) => ({ cat_name, quantity }));
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
    new SlashCommandBuilder()
      .setName("scrapepfps")
      .setDescription("Admin Only: Collect profiles from any shared server and save images to the volume mount")
      .addIntegerOption((option) => option.setName("count").setDescription("Number of profiles to save").setRequired(true))
      .addStringOption((option) => option.setName("server_id").setDescription("ID of the server you want to scrape profiles from").setRequired(true)),
    new SlashCommandBuilder()
      .setName("downloadvolume")
      .setDescription("Admin Only: Compresses and exports your entire data storage directory"),
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

  setInterval(async () => {
    const state = loadData();
    for (const [guildId, channelId] of Object.entries(state.serverSetups)) {
      const guild = client.guilds.cache.get(guildId);
      if (guild && channelId) {
        triggerCatDrop(guild, channelId).catch(console.error);
      }
    }
  }, 600_000); 
});

// --- INTERACTIONS & MESSAGE LISTENER ---
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  const guildId = message.guild.id;
  const state = loadData();
  let targetChannelId = state.serverSetups[guildId];

  const currentCount = (state.serverMessageCounters[guildId] || 0) + 1;
  state.serverMessageCounters[guildId] = currentCount;
  saveData(state);

  if (currentCount >= 100) {
    const latestState = loadData();
    latestState.serverMessageCounters[guildId] = 0;

    if (!targetChannelId) {
      const textChannels = message.guild.channels.cache.filter((c) => c.isTextBased());
      if (textChannels.size > 0) {
        const randomChannel = textChannels.random();
        targetChannelId = randomChannel.id;
        latestState.serverSetups[guildId] = targetChannelId;
      }
    }
    
    saveData(latestState);

    if (targetChannelId) {
      await triggerCatDrop(message.guild, targetChannelId);
    }
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;

  const { commandName, options, user, channelId } = interaction;

  // --- DOWNLOAD VOLUME COMMAND ---
  if (commandName === "downloadvolume") {
    if (user.id !== "1258415712163205261") {
      return interaction.reply({
        content: "❌ **Error:** You do not have permission to execute this developer command.",
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      if (!fs.existsSync(STORAGE_DIR)) {
        return interaction.editReply({ content: "❌ No volume directory data found to package." });
      }

      await interaction.editReply({ content: "⏳ Scanning volume directories and preparing archive matrix..." });

      // Build an automated inventory array of all files inside our persistent folder
      const allFiles = [];
      const scanDir = (dirPath) => {
        const items = fs.readdirSync(dirPath);
        for (const item of items) {
          const fullPath = path.join(dirPath, item);
          if (fs.statSync(fullPath).isDirectory()) {
            scanDir(fullPath);
          } else {
            allFiles.push(fullPath);
          }
        }
      };
      scanDir(STORAGE_DIR);

      if (allFiles.length === 0) {
        return interaction.editReply({ content: "❌ Your persistent volume directory is completely empty." });
      }

      // Calculate total uncompressed space
      let totalSizeRaw = 0;
      allFiles.forEach(f => { totalSizeRaw += fs.statSync(f).size; });

      // Safety Guard: If raw uncompressed size exceeds 50MB, compression won't drop it under Discord's 25MB limit anyway
      if (totalSizeRaw > 50 * 1024 * 1024) {
        return interaction.editReply({
          content: `⚠️ **Volume Size Alert:** Your volume data contains too many physical profile images (${(totalSizeRaw / (1024 * 1024)).toFixed(2)} MB uncompressed).\n\nThis completely exceeds Discord's file delivery rules. Please download the directory files using your **Railway CLI interface** or via **Railway Dashboard logs** instead.`
        });
      }

      await interaction.editReply({ content: `⏳ Bundling and compressing **${allFiles.length}** volume components via gzip matrix structure...` });

      // Generate a structured tarball stream format directly inside a buffer payload array
      const filesPayload = [];
      for (const file of allFiles) {
        const relativePath = path.relative(STORAGE_DIR, file);
        const dataBuffer = fs.readFileSync(file);
        filesPayload.push({ path: relativePath, data: dataBuffer.toString("base64") });
      }

      const compressedBuffer = zlib.gzipSync(Buffer.from(JSON.stringify(filesPayload)));

      if (compressedBuffer.length > 24.5 * 1024 * 1024) {
        return interaction.editReply({
          content: `❌ **Compression Error:** Even compiled, the volume payload is **${(compressedBuffer.length / (1024 * 1024)).toFixed(2)} MB**, which breaks Discord's 25MB size ceiling.`
        });
      }

      await interaction.editReply({
        content: `✅ **Extraction successful!** Here is the complete compression archive of your Railway local persistent storage volume layout:`,
        files: [{
          attachment: compressedBuffer,
          name: `railway_volume_backup_${Date.now()}.tar.gz`
        }]
      });

    } catch (err) {
      console.error("Volume backup engine failed:", err);
      return interaction.editReply({ content: `❌ Backup compilation crashed: ${err.message}` });
    }
  }

  // --- SCRAPE PFPS COMMAND ---
  if (commandName === "scrapepfps") {
    if (user.id !== "1258415712163205261") {
      return interaction.reply({
        content: "❌ **Error:** You do not have permission to execute this developer command.",
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    const limit = options.getInteger("count");
    const targetServerId = options.getString("server_id").trim();

    if (limit <= 0) {
      return interaction.editReply({ content: "❌ Please specify a count greater than 0." });
    }

    const targetGuild = client.guilds.cache.get(targetServerId);
    if (!targetGuild) {
      return interaction.editReply({ 
        content: `❌ **Error:** The bot is not currently in a server with the ID \`${targetServerId}\`, or the ID is incorrect.` 
      });
    }

    try {
      await interaction.editReply({ content: `⏳ Accessing target server: **${targetGuild.name}**... Fetching membership directory...` });
      const fetchedMembers = await targetGuild.members.fetch();
      
      const logRecords = [];
      let counter = 0;

      await interaction.editReply({ content: `⏳ Found **${fetchedMembers.size}** records. Downloading images to permanent storage...` });

      for (const [_, member] of fetchedMembers) {
        if (counter >= limit) break;

        const avatarUrl = member.user.displayAvatarURL({ size: 512, extension: "png" });
        const fileName = `${member.id}.png`;
        const filePath = path.join(PFP_OUTPUT_DIR, fileName);

        try {
          const imgResponse = await fetch(avatarUrl);
          if (imgResponse.ok) {
            const arrayBuffer = await imgResponse.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            
            fs.writeFileSync(filePath, buffer);
            logRecords.push(`User: ${member.user.tag} (${member.id}) -> Saved from server: [${targetGuild.name}]`);
            counter++;
          }
        } catch (downloadError) {
          console.error(`Failed downloading profile image for user ${member.id}:`, downloadError.message);
        }
      }

      if (logRecords.length === 0) {
        return interaction.editReply({ content: "❌ No profile images could be downloaded or stored." });
      }

      const txtContent = `=== SCRAPED PROFILE PICTURES (CROSS-SERVER DISK SAVE) ===\nSource Guild: ${targetGuild.name} (${targetGuild.id})\nTotal Saved: ${logRecords.length}\n\n` + logRecords.join("\n");
      const confirmationBuffer = Buffer.from(txtContent, "utf-8");

      await interaction.editReply({
        content: `✅ Done! **${logRecords.length}** profile images from server **${targetGuild.name}** have been saved into your persistent Railway folder \`/app/data/scraped_pfps/\`. Here is your processing report:`,
        files: [{
          attachment: confirmationBuffer,
          name: `cross_scrape_report_${Date.now()}.txt`
        }]
      });

    } catch (error) {
      console.error("Failed to extract and download server profiles cross-guild:", error);
      return interaction.editReply({ content: `❌ Cross-server extraction failed: ${error.message}` });
    }
  }

  // --- PRE-EXISTING COMMANDS ---
  if (commandName === "serversetup") {
    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: "❌ This command must be used within a server.", ephemeral: true });

    let chosenChannel = options.getChannel("channel");

    if (!chosenChannel) {
      const textChannels = guild.channels.cache.filter((c) => c.isTextBased());
      if (textChannels.size === 0) return interaction.reply({ content: "❌ No text channels found!", ephemeral: true });
      chosenChannel = textChannels.random();
    }

    const state = loadData();
    state.serverSetups[guild.id] = chosenChannel.id;
    saveData(state);

    return interaction.reply({ content: `✅ **Success!** Cat drops configured in <#${chosenChannel.id}>.` });
  }

  if (commandName === "pickup") {
    const activeCat = activeDrops.get(channelId);
    if (!activeCat) return interaction.reply({ content: "❌ There is no wild cat running around in this channel!", ephemeral: true });

    activeDrops.delete(channelId);
    addUserCat(user.id, activeCat.name, 1);

    return interaction.reply({
      content: `🎉 **${user.username}** picked up the **[${activeCat.rarity}]** ${activeCat.emoji} **${activeCat.name}**! Check your \`/catstorage\`.`,
    });
  }

  if (commandName === "catstorage") {
    await interaction.deferReply({ ephemeral: true });
    const items = getUserInventory(user.id);

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
    const myQuantity = myMatch ? getUserCatQuantity(user.id, myMatch.name) : 0;
    if (!myMatch || myQuantity <= 0) return interaction.reply({ content: `❌ You do not own a cat named "${yourCatInput}"!`, ephemeral: true });

    let theirMatch = null;
    const isGift = theirCatInput.toLowerCase() === "none";

    if (!isGift) {
      theirMatch = CATS.find((c) => c.name.toLowerCase() === theirCatInput.toLowerCase());
      const theirQuantity = theirMatch ? getUserCatQuantity(targetUser.id, theirMatch.name) : 0;
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
        const senderHasCat = getUserCatQuantity(user.id, myMatch.name) > 0;
        const receiverHasCat = isGift || getUserCatQuantity(targetUser.id, theirMatch.name) > 0;

        if (senderHasCat && receiverHasCat) {
          removeUserCat(user.id, myMatch.name, 1);
          if (isGift) {
            addUserCat(targetUser.id, myMatch.name, 1);
            await interaction.editReply({ content: `🎁 **GIFT COMPLETE!**\n\n${user} gifted ${myMatch.emoji} **${myMatch.name}** to ${targetUser}!`, components: [disabledRow] });
          } else {
            addUserCat(user.id, theirMatch.name, 1);
            removeUserCat(targetUser.id, theirMatch.name, 1);
            addUserCat(targetUser.id, myMatch.name, 1);
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