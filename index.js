import {
  ActivityType,
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import fs from "fs";
import path from "path";
import zlib from "zlib"; // Built-in Node tool for data compression ops

const token = process.env.DISCORD_BOT_TOKEN;
const endpoint = process.env.SOFTCARD_PRESENCE_ENDPOINT || "https://softcard.cc/api/discord/presence";
const secret = process.env.DISCORD_PRESENCE_SYNC_SECRET || process.env.SOFTCARD_PRESENCE_SYNC_SECRET;
const presenceGuildId = process.env.DISCORD_GUILD_ID || "";
const downloadVolumePassword = process.env.DOWNLOAD_VOLUME_PASSWORD || "";
const MAX_DISCORD_FILE_BYTES = 24.5 * 1024 * 1024;

const watchedIds = new Set(
  (process.env.WATCHED_DISCORD_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

if (!token) throw new Error("Missing DISCORD_BOT_TOKEN.");
if (!secret) throw new Error("Missing DISCORD_PRESENCE_SYNC_SECRET or SOFTCARD_PRESENCE_SYNC_SECRET.");

const activityNames = {
  [ActivityType.Playing]: "Playing",
  [ActivityType.Streaming]: "Streaming",
  [ActivityType.Listening]: "Listening to",
  [ActivityType.Watching]: "Watching",
  [ActivityType.Competing]: "Competing in",
};

const activityPriority = {
  [ActivityType.Streaming]: 1,
  [ActivityType.Listening]: 2,
  [ActivityType.Playing]: 3,
  [ActivityType.Watching]: 4,
  [ActivityType.Competing]: 5,
};

const lastPayloadByUser = new Map();
const lastSentAtByUser = new Map();
const MIN_SYNC_MS = 15_000;

// --- GAME DATA LOCAL PERSISTENCE LAYER ---
const STORAGE_DIR = "./data";
const STORAGE_FILE = path.join(STORAGE_DIR, "storage.json");
const PFP_OUTPUT_DIR = path.join(STORAGE_DIR, "scraped_pfps");
const DEFAULT_STORAGE = {
  serverSetups: {},
  serverMessageCounters: {},
  stoppedCatServers: {},
  userStorage: {},
  userItems: {},
  exploreCooldowns: {},
  catCare: {},
  giveaways: {},
};

function initStorage() {
  try {
    if (!fs.existsSync(STORAGE_DIR)) {
      fs.mkdirSync(STORAGE_DIR, { recursive: true });
    }
    if (!fs.existsSync(PFP_OUTPUT_DIR)) {
      fs.mkdirSync(PFP_OUTPUT_DIR, { recursive: true });
    }
    if (!fs.existsSync(STORAGE_FILE)) {
      fs.writeFileSync(STORAGE_FILE, JSON.stringify(DEFAULT_STORAGE, null, 2), "utf8");
    }
  } catch (error) {
    console.error("Failed to initialize storage folders:", error);
  }
}

function loadData() {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      const data = fs.readFileSync(STORAGE_FILE, "utf8");
      return { ...DEFAULT_STORAGE, ...JSON.parse(data) };
    }
  } catch (error) {
    console.error("Error reading data from storage file, returning safe defaults:", error);
  }
  return { ...DEFAULT_STORAGE };
}

function saveData(data) {
  try {
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (error) {
    console.error("Error writing data state to storage file:", error);
  }
}

initStorage();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = (year - 1980) << 9 | (date.getMonth() + 1) << 5 | date.getDate();
  return { time, day };
}

function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { time, day } = dosDateTime();

  for (const file of files) {
    const nameBuffer = Buffer.from(file.path.replace(/\\/g, "/"), "utf8");
    const dataBuffer = fs.readFileSync(file.fullPath);
    const checksum = crc32(dataBuffer);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(day, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(dataBuffer.length, 18);
    localHeader.writeUInt32LE(dataBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, dataBuffer);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(day, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(dataBuffer.length, 20);
    centralHeader.writeUInt32LE(dataBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + dataBuffer.length;
  }

  const centralStart = offset;
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function scanFiles(rootDir) {
  const files = [];
  const scanDir = (dirPath) => {
    const items = fs.readdirSync(dirPath);
    for (const item of items) {
      const fullPath = path.join(dirPath, item);
      if (fs.statSync(fullPath).isDirectory()) {
        scanDir(fullPath);
      } else {
        files.push({
          fullPath,
          path: path.relative(rootDir, fullPath),
          size: fs.statSync(fullPath).size,
        });
      }
    }
  };
  scanDir(rootDir);
  return files;
}

function buildSplitZipArchives(files) {
  const parts = [];
  let currentFiles = [];
  let currentBuffer = null;

  for (const file of files) {
    const testFiles = [...currentFiles, file];
    const testBuffer = buildZip(testFiles);

    if (testBuffer.length <= MAX_DISCORD_FILE_BYTES) {
      currentFiles = testFiles;
      currentBuffer = testBuffer;
      continue;
    }

    if (currentFiles.length === 0) {
      throw new Error(`"${file.path}" is too large to send through Discord by itself (${(testBuffer.length / (1024 * 1024)).toFixed(2)} MB).`);
    }

    parts.push({ files: currentFiles, buffer: currentBuffer });
    currentFiles = [file];
    currentBuffer = buildZip(currentFiles);

    if (currentBuffer.length > MAX_DISCORD_FILE_BYTES) {
      throw new Error(`"${file.path}" is too large to send through Discord by itself (${(currentBuffer.length / (1024 * 1024)).toFixed(2)} MB).`);
    }
  }

  if (currentFiles.length > 0 && currentBuffer) {
    parts.push({ files: currentFiles, buffer: currentBuffer });
  }

  return parts;
}

async function handleDownloadVolume(interaction, options) {
  const providedPassword = options.getString("password", true);

  if (!downloadVolumePassword) {
    return interaction.reply({
      content: "ERROR: DOWNLOAD_VOLUME_PASSWORD is not configured on the bot host.",
      ephemeral: true,
    });
  }

  if (providedPassword !== downloadVolumePassword) {
    return interaction.reply({
      content: "ERROR: Incorrect download password.",
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    if (!fs.existsSync(STORAGE_DIR)) {
      return interaction.editReply({ content: "No volume directory data found to package." });
    }

    await interaction.editReply({ content: "Scanning volume directories and preparing zip archives..." });

    const allFiles = scanFiles(STORAGE_DIR);
    if (allFiles.length === 0) {
      return interaction.editReply({ content: "Your persistent volume directory is completely empty." });
    }

    const totalSizeRaw = allFiles.reduce((sum, file) => sum + file.size, 0);
    await interaction.editReply({
      content: `Bundling **${allFiles.length}** files (${(totalSizeRaw / (1024 * 1024)).toFixed(2)} MB raw) into Discord-safe zip parts...`,
    });

    const archiveParts = buildSplitZipArchives(allFiles);
    const timestamp = Date.now();

    await interaction.editReply({
      content: `Backup ready. Sending **${archiveParts.length}** zip file${archiveParts.length === 1 ? "" : "s"} below.`,
    });

    for (let index = 0; index < archiveParts.length; index++) {
      const part = archiveParts[index];
      const partNumber = String(index + 1).padStart(3, "0");
      const totalParts = String(archiveParts.length).padStart(3, "0");

      await interaction.followUp({
        content: `Volume backup part **${index + 1}/${archiveParts.length}** - ${part.files.length} file${part.files.length === 1 ? "" : "s"}, ${(part.buffer.length / (1024 * 1024)).toFixed(2)} MB.`,
        ephemeral: true,
        files: [{
          attachment: part.buffer,
          name: `railway_volume_backup_${timestamp}_part${partNumber}_of_${totalParts}.zip`,
        }],
      });
    }
  } catch (err) {
    console.error("Volume backup engine failed:", err);
    const message = `Backup compilation crashed: ${err.message}`;
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content: message });
    }
    return interaction.reply({ content: message, ephemeral: true });
  }
}

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
const CAT_DROP_TTL_MS = 2 * 60 * 1000;
const CAT_RARITY_INFO = {
  Common: { icon: "C", points: 1 },
  Uncommon: { icon: "U", points: 3 },
  Rare: { icon: "R", points: 7 },
  Epic: { icon: "E", points: 18 },
  Legendary: { icon: "L", points: 50 },
};
const EXPLORE_COOLDOWN_MS = 4 * 60 * 1000;
const EXPLORE_ITEMS = [
  { name: "Yarn Ball", rarity: "Common", weight: 45, points: 1 },
  { name: "Cat Treat", rarity: "Common", weight: 40, points: 1 },
  { name: "Fish Snack", rarity: "Common", weight: 34, points: 1 },
  { name: "Scratched Coin", rarity: "Uncommon", weight: 22, points: 3 },
  { name: "Tiny Bell", rarity: "Uncommon", weight: 18, points: 3 },
  { name: "Cozy Blanket", rarity: "Uncommon", weight: 14, points: 3 },
  { name: "Moon Whisker", rarity: "Rare", weight: 9, points: 8 },
  { name: "Golden Paw", rarity: "Epic", weight: 4, points: 20 },
  { name: "Ancient Catnip", rarity: "Legendary", weight: 1, points: 60 },
];
const CAT_FOOD_ITEMS = new Set(["Cat Treat", "Fish Snack", "Ancient Catnip"]);
const RARITY_ORDER = ["Common", "Uncommon", "Rare", "Epic", "Legendary"];
const CAT_UPGRADE_RECIPES = {
  Common: { next: "Uncommon", items: { "Cat Treat": 3, "Yarn Ball": 2 } },
  Uncommon: { next: "Rare", items: { "Fish Snack": 4, "Tiny Bell": 2 } },
  Rare: { next: "Epic", items: { "Moon Whisker": 3, "Cozy Blanket": 2 } },
  Epic: { next: "Legendary", items: { "Golden Paw": 2, "Ancient Catnip": 1 } },
};
const HELP_LINES = [
  "`/help` - Show every command and what it does.",
  "`/serversetup [channel]` - Set the channel where wild cats spawn.",
  "`/stopcat` - Admin: stop wild cat drops for this server. Run `/serversetup` to turn them back on.",
  "`/giveaway` - Admin: start a timed giveaway with a join button.",
  "`/cat [favorite]` - Open the cat panel. Optionally set your favorite cat.",
  "`/pickup` - Claim the active wild cat in the current channel.",
  "`/trade` - Trade a cat or gift one to another user.",
  "Cat panel buttons - Explore, Vault, Dex, Leaderboard, Care, Feed, Play, Upgrade, Bag.",
  "`/scrapepfps` - Admin: save profile pictures from a shared server.",
  "`/downloadvolume` - Admin: download storage backups with a password.",
];

function catRef(catName) {
  return CATS.find((cat) => cat.name.toLowerCase() === String(catName || "").toLowerCase());
}

function findCat(input) {
  const query = String(input || "").trim().toLowerCase();
  if (!query) return null;
  return CATS.find((cat) => cat.name.toLowerCase() === query)
    || CATS.find((cat) => cat.name.toLowerCase().includes(query));
}

function catPoints(catName, quantity = 1) {
  const reference = catRef(catName);
  return (CAT_RARITY_INFO[reference?.rarity || "Common"]?.points || 1) * Number(quantity || 0);
}

function formatCat(catName, quantity = 1) {
  const reference = catRef(catName);
  const rarity = reference?.rarity || "Common";
  const icon = CAT_RARITY_INFO[rarity]?.icon || "C";
  return `${reference ? reference.emoji : "cat"} **${catName}** x \`${quantity}\` [${rarity} ${icon}]`;
}

function inventoryStats(items) {
  const totalCats = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const uniqueCats = items.length;
  const score = items.reduce((sum, item) => sum + catPoints(item.cat_name, item.quantity), 0);
  const byRarity = {};
  for (const item of items) {
    const rarity = catRef(item.cat_name)?.rarity || "Common";
    byRarity[rarity] = (byRarity[rarity] || 0) + Number(item.quantity || 0);
  }
  return { totalCats, uniqueCats, score, byRarity };
}

function chooseWeighted(items) {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  let random = Math.random() * totalWeight;
  for (const item of items) {
    if (random < item.weight) return item;
    random -= item.weight;
  }
  return items[0];
}

function addUserItem(userId, itemName, amount = 1) {
  const state = loadData();
  if (!state.userItems[userId]) state.userItems[userId] = {};
  state.userItems[userId][itemName] = (state.userItems[userId][itemName] || 0) + amount;
  saveData(state);
}

function getUserItems(userId) {
  const state = loadData();
  const bag = state.userItems[userId] || {};
  return Object.entries(bag)
    .map(([name, quantity]) => ({ name, quantity }))
    .filter((item) => Number(item.quantity) > 0)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function getUserItemQuantity(userId, itemName) {
  const state = loadData();
  return Number(state.userItems[userId]?.[itemName] || 0);
}

function removeUserItem(userId, itemName, amount = 1) {
  const state = loadData();
  const bag = state.userItems[userId];
  if (!bag || Number(bag[itemName] || 0) < amount) return false;
  bag[itemName] = Number(bag[itemName]) - amount;
  if (bag[itemName] <= 0) delete bag[itemName];
  saveData(state);
  return true;
}

function hasRecipeItems(userId, recipe) {
  return Object.entries(recipe.items).every(([itemName, amount]) => getUserItemQuantity(userId, itemName) >= amount);
}

function consumeRecipeItems(userId, recipe) {
  if (!hasRecipeItems(userId, recipe)) return false;
  for (const [itemName, amount] of Object.entries(recipe.items)) {
    removeUserItem(userId, itemName, amount);
  }
  return true;
}

function careDefaults(catName = "") {
  return {
    favoriteCat: catName,
    hunger: 70,
    happiness: 70,
    level: 1,
    xp: 0,
    lastCareAt: Date.now(),
  };
}

function normalizedCare(userId) {
  const state = loadData();
  const current = { ...careDefaults(), ...(state.catCare[userId] || {}) };
  const hoursPassed = Math.max(0, Math.floor((Date.now() - Number(current.lastCareAt || Date.now())) / (60 * 60 * 1000)));
  if (hoursPassed > 0) {
    current.hunger = Math.max(0, Number(current.hunger || 0) - hoursPassed * 4);
    current.happiness = Math.max(0, Number(current.happiness || 0) - hoursPassed * 3);
    current.lastCareAt = Date.now();
    state.catCare[userId] = current;
    saveData(state);
  }
  return current;
}

function saveCare(userId, care) {
  const state = loadData();
  state.catCare[userId] = { ...care, lastCareAt: Date.now() };
  saveData(state);
}

function careEmbed(user, care, title = "Cat Care") {
  const cat = catRef(care.favoriteCat);
  const recipe = cat ? CAT_UPGRADE_RECIPES[cat.rarity] : null;
  const recipeText = recipe
    ? Object.entries(recipe.items).map(([item, amount]) => `${item} x${amount}`).join(", ")
    : "Max rarity reached.";

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(cat ? `${cat.emoji} **${cat.name}** [${cat.rarity}]` : "No favorite cat selected yet. Use `/catcare favorite cat:<name>`.")
    .addFields(
      { name: "Stats", value: `Hunger: **${care.hunger}/100**\nHappiness: **${care.happiness}/100**\nLevel: **${care.level}** | XP: **${care.xp}**`, inline: true },
      { name: "Upgrade", value: recipe ? `Next: **${recipe.next}**\nNeeds: ${recipeText}` : recipeText, inline: true },
      { name: "How to care", value: "Explore for food/items with `/explore`, then use `/catcare feed`, `/catcare play`, or `/catcare upgrade`.", inline: false }
    )
    .setFooter({ text: user.username })
    .setColor(cat?.rarity === "Legendary" ? 0xf5b942 : cat?.rarity === "Epic" ? 0x9b5cff : cat?.rarity === "Rare" ? 0x4ea1ff : 0x62d26f);
}

function randomCatByRarity(rarity) {
  const matches = CATS.filter((cat) => cat.rarity === rarity);
  return matches[Math.floor(Math.random() * matches.length)] || null;
}

function getExploreCooldown(userId) {
  const state = loadData();
  const readyAt = Number(state.exploreCooldowns[userId] || 0);
  return Math.max(0, readyAt - Date.now());
}

function setExploreCooldown(userId) {
  const state = loadData();
  state.exploreCooldowns[userId] = Date.now() + EXPLORE_COOLDOWN_MS;
  saveData(state);
}

async function triggerBetterCatDrop(guild, channelId) {
  const state = loadData();
  if (state.stoppedCatServers?.[guild.id]) return;

  const channel = guild.channels.cache.get(channelId);
  if (!channel) return;

  const cat = chooseRandomCat();
  const previousDrop = activeDrops.get(channelId);
  if (previousDrop?.timeoutId) clearTimeout(previousDrop.timeoutId);

  const dropId = `${channelId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const expiresAt = Date.now() + CAT_DROP_TTL_MS;
  const timeoutId = setTimeout(() => {
    const activeDrop = activeDrops.get(channelId);
    if (activeDrop?.id === dropId) activeDrops.delete(channelId);
  }, CAT_DROP_TTL_MS);

  activeDrops.set(channelId, { ...cat, id: dropId, expiresAt, timeoutId });

  const rarity = CAT_RARITY_INFO[cat.rarity] || CAT_RARITY_INFO.Common;
  await channel.send({
    content: [
      "**A wild cat spawned.**",
      `${cat.emoji} **${cat.name}**`,
      `Rarity: **${cat.rarity}** [${rarity.icon}] | Value: **${rarity.points}** points`,
      `Use \`/pickup\` within **${Math.floor(CAT_DROP_TTL_MS / 1000)} seconds** to claim it.`,
    ].join("\n"),
  });
}

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
  return [...(presence.activities || [])]
    .filter((activity) => activity.type !== ActivityType.Custom)
    .sort((a, b) => (activityPriority[a.type] || 99) - (activityPriority[b.type] || 99))[0] || null;
}

function activityImage(activity) {
  if (!activity?.assets) return "";
  return activity.assets.largeImageURL({ size: 128 }) || activity.assets.smallImageURL({ size: 128 }) || "";
}

function discordAvatarUrl(user) {
  if (!user) return "";
  return user.displayAvatarURL?.({ size: 128, extension: user.avatar?.startsWith?.("a_") ? "gif" : "png" }) || "";
}

function displayDiscordName(presence, user) {
  return String(user?.globalName || presence.member?.displayName || user?.username || "Discord").slice(0, 40);
}

function buildPayload(presence) {
  const activity = pickActivity(presence);
  const user = presence.user || presence.member?.user || client.users.cache.get(presence.userId);
  const guild = (presenceGuildId && client.guilds.cache.get(presenceGuildId)) || presence.guild;
  const guildIcon = guild?.iconURL({ size: 128 }) || "";
  const status = presence.status || "offline";

  return {
    discordId: presence.userId,
    discordName: displayDiscordName(presence, user),
    discordUsername: user?.username || "",
    discordAvatar: discordAvatarUrl(user),
    discordUrl: presence.userId ? `https://discord.com/users/${presence.userId}` : "",
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
  const state = loadData();
  if (state.stoppedCatServers?.[guild.id]) return;

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
  return Object.entries(vault)
    .map(([cat_name, quantity]) => ({ cat_name, quantity }))
    .filter((item) => Number(item.quantity) > 0)
    .sort((a, b) => {
      const scoreDiff = catPoints(b.cat_name, 1) - catPoints(a.cat_name, 1);
      if (scoreDiff !== 0) return scoreDiff;
      return a.cat_name.localeCompare(b.cat_name);
    });
}

function getLeaderboard(limit = 10) {
  const state = loadData();
  return Object.entries(state.userStorage || {})
    .map(([userId]) => {
      const items = getUserInventory(userId);
      return { userId, ...inventoryStats(items) };
    })
    .filter((row) => row.totalCats > 0)
    .sort((a, b) => b.score - a.score || b.uniqueCats - a.uniqueCats || b.totalCats - a.totalCats)
    .slice(0, limit);
}

// --- GIVEAWAY SYSTEM ---
const GIVEAWAY_DURATIONS = [
  { label: "10 seconds", value: "10s", ms: 10 * 1000 },
  { label: "5 minutes", value: "5m", ms: 5 * 60 * 1000 },
  { label: "30 minutes", value: "30m", ms: 30 * 60 * 1000 },
  { label: "1 hour", value: "1h", ms: 60 * 60 * 1000 },
  { label: "5 hours", value: "5h", ms: 5 * 60 * 60 * 1000 },
  { label: "24 hours", value: "24h", ms: 24 * 60 * 60 * 1000 },
  { label: "48 hours", value: "48h", ms: 48 * 60 * 60 * 1000 },
];
const activeGiveawayTimers = new Map();

function getGiveawayDuration(value) {
  return GIVEAWAY_DURATIONS.find((duration) => duration.value === value) || GIVEAWAY_DURATIONS[0];
}

function formatGiveawayDuration(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

function giveawayEmbed(giveaway, ended = false, winners = []) {
  const entrantCount = giveaway.entrants?.length || 0;
  const endsTimestamp = Math.floor(giveaway.endsAt / 1000);
  const description = ended
    ? winners.length
      ? `Winner${winners.length === 1 ? "" : "s"}: ${winners.map((id) => `<@${id}>`).join(", ")}`
      : "No valid entries were submitted."
    : `Ends <t:${endsTimestamp}:R>\nHosted by <@${giveaway.hostId}>`;

  return new EmbedBuilder()
    .setTitle(ended ? "Giveaway Ended" : "Giveaway")
    .setDescription(description)
    .addFields(
      { name: "Prize", value: giveaway.prize, inline: false },
      { name: "Entries", value: String(entrantCount), inline: true },
      { name: "Winners", value: String(giveaway.winnerCount), inline: true },
      { name: "Ends", value: `<t:${endsTimestamp}:f>`, inline: true },
    )
    .setColor(ended ? 0x8a8f98 : 0x62d26f);
}

function giveawayComponents(giveaway, ended = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`giveaway:join:${giveaway.id}`)
        .setLabel(ended ? "Giveaway Ended" : "Enter Giveaway")
        .setStyle(ended ? ButtonStyle.Secondary : ButtonStyle.Success)
        .setDisabled(ended),
    ),
  ];
}

function saveGiveaway(giveaway) {
  const state = loadData();
  state.giveaways = state.giveaways || {};
  state.giveaways[giveaway.id] = giveaway;
  saveData(state);
}

function getGiveaway(id) {
  const state = loadData();
  return state.giveaways?.[id] || null;
}

function pickGiveawayWinners(entrants, count) {
  const shuffled = [...new Set(entrants || [])].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(shuffled.length, Math.max(1, count)));
}

function scheduleGiveawayEnd(giveaway) {
  if (activeGiveawayTimers.has(giveaway.id)) clearTimeout(activeGiveawayTimers.get(giveaway.id));
  const remainingMs = Math.max(0, giveaway.endsAt - Date.now());
  const timeoutId = setTimeout(() => {
    endGiveaway(giveaway.id).catch((error) => console.error("Giveaway end failed:", error));
  }, remainingMs);
  activeGiveawayTimers.set(giveaway.id, timeoutId);
}

async function endGiveaway(giveawayId) {
  const giveaway = getGiveaway(giveawayId);
  if (!giveaway || giveaway.ended) return;

  activeGiveawayTimers.delete(giveawayId);
  const winners = pickGiveawayWinners(giveaway.entrants, giveaway.winnerCount);
  const endedGiveaway = { ...giveaway, ended: true, winners };
  saveGiveaway(endedGiveaway);

  const channel = await client.channels.fetch(giveaway.channelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const message = await channel.messages.fetch(giveaway.messageId).catch(() => null);
  if (message) {
    await message.edit({
      embeds: [giveawayEmbed(endedGiveaway, true, winners)],
      components: giveawayComponents(endedGiveaway, true),
    }).catch(() => {});
  }

  if (winners.length > 0) {
    await channel.send(`Giveaway ended for **${giveaway.prize}**. Winner${winners.length === 1 ? "" : "s"}: ${winners.map((id) => `<@${id}>`).join(", ")}`).catch(() => {});
  } else {
    await channel.send(`Giveaway ended for **${giveaway.prize}**. No one entered.`).catch(() => {});
  }
}

function resumeGiveawayTimers() {
  const state = loadData();
  for (const giveaway of Object.values(state.giveaways || {})) {
    if (!giveaway.ended) scheduleGiveawayEnd(giveaway);
  }
}

// --- INITIALIZE SLASH COMMANDS ON CLIENT READY ---
client.once("ready", async () => {
  console.log(`Softcard presence bot online as ${client.user.tag}`);
  loadCustomServerEmojis();
  console.log(`Initial cached presences: ${syncCachedPresences(true)}`);

  const commands = [
    new SlashCommandBuilder().setName("help").setDescription("Show all bot commands and what they do"),
    new SlashCommandBuilder()
      .setName("serversetup")
      .setDescription("Configure the spawn channel for cats")
      .addChannelOption((option) => option.setName("channel").setDescription("The channel where cats drop")),
    new SlashCommandBuilder()
      .setName("stopcat")
      .setDescription("Admin Only: Stop wild cat drops for this server")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName("giveaway")
      .setDescription("Admin Only: Start a timed giveaway")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addStringOption((option) => option.setName("prize").setDescription("What users can win").setRequired(true))
      .addStringOption((option) =>
        option
          .setName("time")
          .setDescription("How long the giveaway should run")
          .setRequired(true)
          .addChoices(...GIVEAWAY_DURATIONS.map((duration) => ({ name: duration.label, value: duration.value })))
      )
      .addIntegerOption((option) =>
        option
          .setName("winners")
          .setDescription("Number of winners")
          .setMinValue(1)
          .setMaxValue(20)
      )
      .addChannelOption((option) => option.setName("channel").setDescription("Channel to post the giveaway in")),
    new SlashCommandBuilder()
      .setName("cat")
      .setDescription("Open the cat system panel with buttons")
      .addStringOption((option) => option.setName("favorite").setDescription("Optional: set favorite cat by name")),
    new SlashCommandBuilder().setName("pickup").setDescription("Pick up an active cat drop in this channel"),
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
      .setDescription("Admin Only: Compresses and exports your entire data storage directory")
      .addStringOption((option) =>
        option
          .setName("password")
          .setDescription("Download password")
          .setRequired(true)
      ),
  ].map((command) => command.toJSON());

  const rest = new REST({ version: "10" }).setToken(token);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error("Error refreshing slash commands:", error);
  }

  resumeGiveawayTimers();

  setInterval(() => {
    syncCachedPresences(false);
  }, 60_000);

  setInterval(async () => {
    const state = loadData();
    for (const [guildId, channelId] of Object.entries(state.serverSetups)) {
      if (state.stoppedCatServers?.[guildId]) continue;
      const guild = client.guilds.cache.get(guildId);
      if (guild && channelId) {
        triggerBetterCatDrop(guild, channelId).catch(console.error);
      }
    }
  }, 600_000); 
});

// --- INTERACTIONS & MESSAGE LISTENER ---
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  const guildId = message.guild.id;
  const state = loadData();
  if (state.stoppedCatServers?.[guildId]) return;

  let targetChannelId = state.serverSetups[guildId];

  const currentCount = (state.serverMessageCounters[guildId] || 0) + 1;
  state.serverMessageCounters[guildId] = currentCount;
  saveData(state);

  if (currentCount >= 100) {
    const latestState = loadData();
    latestState.serverMessageCounters[guildId] = 0;
    if (latestState.stoppedCatServers?.[guildId]) {
      saveData(latestState);
      return;
    }

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
      await triggerBetterCatDrop(message.guild, targetChannelId);
    }
  }
});

function catPanelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("cat:explore").setLabel("Explore").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("cat:care").setLabel("Care").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("cat:feed").setLabel("Feed").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("cat:play").setLabel("Play").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("cat:upgrade").setLabel("Upgrade").setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("cat:vault").setLabel("Vault").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("cat:dex").setLabel("Dex").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("cat:bag").setLabel("Bag").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("cat:leaderboard").setLabel("Leaderboard").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("cat:panel").setLabel("Home").setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function catHomeEmbed(user) {
  const items = getUserInventory(user.id);
  const stats = inventoryStats(items);
  const care = normalizedCare(user.id);
  const favorite = catRef(care.favoriteCat);
  return new EmbedBuilder()
    .setTitle("Cat System")
    .setDescription("Use the buttons below. Use `/cat favorite:<cat name>` once to pick the cat you care for.")
    .addFields(
      { name: "Collection", value: `Score: **${stats.score}**\nCats: **${stats.totalCats}**\nUnique: **${stats.uniqueCats}/${CATS.length}**`, inline: true },
      { name: "Favorite", value: favorite ? `${favorite.emoji} **${favorite.name}** [${favorite.rarity}]\nHunger: **${care.hunger}/100**\nHappy: **${care.happiness}/100**` : "No favorite selected.", inline: true },
      { name: "Core commands", value: "`/cat` panel\n`/pickup` catch spawned cats\n`/trade` trade/gift cats", inline: false },
    )
    .setColor(0x62d26f);
}

function vaultEmbed(user) {
  const items = getUserInventory(user.id);
  if (items.length === 0) {
    return new EmbedBuilder().setTitle("Cat Vault").setDescription("Your cat vault is empty. Use `/pickup` on spawned cats or Explore from this panel.").setColor(0x62d26f);
  }
  const stats = inventoryStats(items);
  return new EmbedBuilder()
    .setTitle(`${user.username}'s Cat Vault`)
    .setDescription(items.slice(0, 25).map((item) => formatCat(item.cat_name, item.quantity)).join("\n"))
    .addFields({ name: "Stats", value: `Score: **${stats.score}** | Total: **${stats.totalCats}** | Unique: **${stats.uniqueCats}/${CATS.length}**` })
    .setColor(0x62d26f);
}

function dexEmbed(user) {
  const items = getUserInventory(user.id);
  const owned = new Set(items.map((item) => item.cat_name));
  const stats = inventoryStats(items);
  const lines = Object.keys(CAT_RARITY_INFO).map((rarity) => {
    const rarityCats = CATS.filter((cat) => cat.rarity === rarity);
    const ownedCount = rarityCats.filter((cat) => owned.has(cat.name)).length;
    return `**${rarity}**: ${ownedCount}/${rarityCats.length} unique, ${stats.byRarity[rarity] || 0} total`;
  });
  return new EmbedBuilder()
    .setTitle(`${user.username}'s CatDex`)
    .setDescription(lines.join("\n"))
    .addFields({ name: "Collection", value: `**${stats.uniqueCats}/${CATS.length}** unique | Score: **${stats.score}**` })
    .setColor(0x62d26f);
}

function bagEmbed(user) {
  const items = getUserItems(user.id);
  return new EmbedBuilder()
    .setTitle(`${user.username}'s Explore Bag`)
    .setDescription(items.length ? items.map((item) => `**${item.name}** x \`${item.quantity}\``).join("\n") : "Your bag is empty. Press Explore to find care and upgrade items.")
    .setColor(0x62d26f);
}

async function leaderboardEmbed(interaction) {
  const rows = getLeaderboard(10);
  if (rows.length === 0) return new EmbedBuilder().setTitle("Cat Leaderboard").setDescription("No cat collectors yet.").setColor(0x62d26f);
  const lines = await Promise.all(rows.map(async (row, index) => {
    const member = interaction.guild?.members.cache.get(row.userId) || await interaction.guild?.members.fetch(row.userId).catch(() => null);
    return `**${index + 1}.** ${member?.user?.username || row.userId} - **${row.score}** pts, ${row.uniqueCats}/${CATS.length} unique, ${row.totalCats} total`;
  }));
  return new EmbedBuilder().setTitle("Cat Leaderboard").setDescription(lines.join("\n")).setColor(0x62d26f);
}

function exploreEmbedForUser(user) {
  const remainingMs = getExploreCooldown(user.id);
  if (remainingMs > 0) {
    const remainingSeconds = Math.ceil(remainingMs / 1000);
    return new EmbedBuilder()
      .setTitle("Explore cooldown")
      .setDescription(`Rest first. Try again in **${Math.ceil(remainingSeconds / 60)}m ${remainingSeconds % 60}s**.`)
      .setColor(0xffb020);
  }

  setExploreCooldown(user.id);
  const foundItem = chooseWeighted(EXPLORE_ITEMS);
  addUserItem(user.id, foundItem.name, 1);
  const foundCat = Math.random() < 0.18;
  let catLine = "No cat followed you home this time.";
  if (foundCat) {
    const cat = chooseRandomCat();
    addUserCat(user.id, cat.name, 1);
    const rarity = CAT_RARITY_INFO[cat.rarity] || CAT_RARITY_INFO.Common;
    catLine = `${cat.emoji} **${cat.name}** [${cat.rarity}], worth **${rarity.points}** points.`;
  }
  const itemTotal = getUserItems(user.id).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  return new EmbedBuilder()
    .setTitle(`${user.username} explored the alleys`)
    .addFields(
      { name: "Item found", value: `**${foundItem.name}** [${foundItem.rarity}]`, inline: true },
      { name: "Cat encounter", value: catLine, inline: false },
      { name: "Bag", value: `**${itemTotal}** total item${itemTotal === 1 ? "" : "s"}`, inline: true },
    )
    .setColor(foundCat ? 0xf5b942 : 0x62d26f);
}

function careActionEmbed(user, action) {
  let care = normalizedCare(user.id);
  if (!care.favoriteCat || getUserCatQuantity(user.id, care.favoriteCat) <= 0) {
    return new EmbedBuilder().setTitle("Pick a favorite cat").setDescription("Use `/cat favorite:<cat name>` first.").setColor(0xffb020);
  }

  if (action === "care") return careEmbed(user, care);
  if (action === "feed") {
    const food = getUserItems(user.id).find((item) => CAT_FOOD_ITEMS.has(item.name));
    if (!food) return new EmbedBuilder().setTitle("No food").setDescription("Explore for Cat Treats, Fish Snacks, or Ancient Catnip.").setColor(0xffb020);
    removeUserItem(user.id, food.name, 1);
    care.hunger = Math.min(100, Number(care.hunger || 0) + (food.name === "Ancient Catnip" ? 45 : food.name === "Fish Snack" ? 30 : 22));
    care.happiness = Math.min(100, Number(care.happiness || 0) + 8);
    care.xp = Number(care.xp || 0) + 5;
    if (care.xp >= care.level * 25) {
      care.xp = 0;
      care.level += 1;
    }
    saveCare(user.id, care);
    return careEmbed(user, care, `Fed ${care.favoriteCat} with ${food.name}`);
  }
  if (action === "play") {
    const toy = getUserItemQuantity(user.id, "Yarn Ball") > 0 ? "Yarn Ball" : getUserItemQuantity(user.id, "Tiny Bell") > 0 ? "Tiny Bell" : "";
    if (!toy) return new EmbedBuilder().setTitle("No toy").setDescription("Explore for a Yarn Ball or Tiny Bell.").setColor(0xffb020);
    removeUserItem(user.id, toy, 1);
    care.happiness = Math.min(100, Number(care.happiness || 0) + (toy === "Tiny Bell" ? 32 : 22));
    care.hunger = Math.max(0, Number(care.hunger || 0) - 6);
    care.xp = Number(care.xp || 0) + 6;
    if (care.xp >= care.level * 25) {
      care.xp = 0;
      care.level += 1;
    }
    saveCare(user.id, care);
    return careEmbed(user, care, `Played with ${care.favoriteCat}`);
  }
  if (action === "upgrade") {
    const currentCat = catRef(care.favoriteCat);
    const recipe = currentCat ? CAT_UPGRADE_RECIPES[currentCat.rarity] : null;
    if (!recipe) return careEmbed(user, care, "This cat is already max rarity");
    if (care.hunger < 60 || care.happiness < 60) return new EmbedBuilder().setTitle("Care required").setDescription("Your favorite cat needs at least 60 hunger and 60 happiness before upgrading.").setColor(0xffb020);
    if (!consumeRecipeItems(user.id, recipe)) return careEmbed(user, care, "Missing upgrade items");
    const upgradedCat = randomCatByRarity(recipe.next);
    removeUserCat(user.id, currentCat.name, 1);
    addUserCat(user.id, upgradedCat.name, 1);
    care.favoriteCat = upgradedCat.name;
    care.hunger = Math.max(35, care.hunger - 25);
    care.happiness = Math.max(35, care.happiness - 20);
    care.level += 1;
    care.xp = 0;
    saveCare(user.id, care);
    return careEmbed(user, care, `${currentCat.name} upgraded into ${upgradedCat.name}`);
  }
  return catHomeEmbed(user);
}

async function catPanelPayload(interaction, action = "panel") {
  if (action === "explore") return { embeds: [exploreEmbedForUser(interaction.user)], components: catPanelComponents() };
  if (action === "vault") return { embeds: [vaultEmbed(interaction.user)], components: catPanelComponents() };
  if (action === "dex") return { embeds: [dexEmbed(interaction.user)], components: catPanelComponents() };
  if (action === "bag") return { embeds: [bagEmbed(interaction.user)], components: catPanelComponents() };
  if (action === "leaderboard") return { embeds: [await leaderboardEmbed(interaction)], components: catPanelComponents() };
  if (["care", "feed", "play", "upgrade"].includes(action)) return { embeds: [careActionEmbed(interaction.user, action)], components: catPanelComponents() };
  return { embeds: [catHomeEmbed(interaction.user)], components: catPanelComponents() };
}

client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton()) {
    if (interaction.customId.startsWith("giveaway:join:")) {
      const giveawayId = interaction.customId.split(":")[2];
      const giveaway = getGiveaway(giveawayId);

      if (!giveaway) {
        return interaction.reply({ content: "This giveaway no longer exists.", ephemeral: true });
      }

      if (giveaway.ended || Date.now() >= giveaway.endsAt) {
        await endGiveaway(giveaway.id).catch((error) => console.error("Giveaway close failed:", error));
        return interaction.reply({ content: "This giveaway has already ended.", ephemeral: true });
      }

      if (giveaway.entrants?.includes(interaction.user.id)) {
        return interaction.reply({ content: "You are already entered in this giveaway.", ephemeral: true });
      }

      const updatedGiveaway = {
        ...giveaway,
        entrants: [...(giveaway.entrants || []), interaction.user.id],
      };
      saveGiveaway(updatedGiveaway);

      const message = await interaction.message.fetch().catch(() => null);
      if (message) {
        await message.edit({
          embeds: [giveawayEmbed(updatedGiveaway)],
          components: giveawayComponents(updatedGiveaway),
        }).catch(() => {});
      }

      return interaction.reply({ content: `You entered the giveaway for **${giveaway.prize}**.`, ephemeral: true });
    }

    if (!interaction.customId.startsWith("cat:")) return;
    const action = interaction.customId.split(":")[1] || "panel";
    return interaction.update(await catPanelPayload(interaction, action));
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName, options, user, channelId } = interaction;

  if (commandName === "giveaway") {
    if (!interaction.guild) {
      return interaction.reply({ content: "This command must be used within a server.", ephemeral: true });
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: "You need Manage Server permission to start giveaways.", ephemeral: true });
    }

    const prize = options.getString("prize", true).trim().slice(0, 250);
    const duration = getGiveawayDuration(options.getString("time", true));
    const winnerCount = options.getInteger("winners") || 1;
    const targetChannel = options.getChannel("channel") || interaction.channel;

    if (!prize) {
      return interaction.reply({ content: "Please enter a prize.", ephemeral: true });
    }

    if (!targetChannel?.isTextBased()) {
      return interaction.reply({ content: "Please choose a text channel for the giveaway.", ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const giveaway = {
      id: `${interaction.id}-${Date.now()}`,
      guildId: interaction.guild.id,
      channelId: targetChannel.id,
      messageId: "",
      prize,
      hostId: user.id,
      winnerCount,
      endsAt: Date.now() + duration.ms,
      entrants: [],
      ended: false,
    };

    const message = await targetChannel.send({
      embeds: [giveawayEmbed(giveaway)],
      components: giveawayComponents(giveaway),
    }).catch((error) => {
      console.error("Failed to create giveaway message:", error);
      return null;
    });

    if (!message) {
      return interaction.editReply({
        content: `I could not post the giveaway in ${targetChannel}. Make sure I can View Channel and Send Messages there.`,
      });
    }

    giveaway.messageId = message.id;
    saveGiveaway(giveaway);
    scheduleGiveawayEnd(giveaway);

    return interaction.editReply({
      content: `Giveaway started in ${targetChannel} for **${prize}**. Duration: **${formatGiveawayDuration(duration.ms)}**.`,
    });
  }

  // --- DOWNLOAD VOLUME COMMAND ---
  if (commandName === "downloadvolume") {
    if (user.id !== "1258415712163205261") {
      return interaction.reply({
        content: "❌ **Error:** You do not have permission to execute this developer command.",
        ephemeral: true,
      });
    }

    return handleDownloadVolume(interaction, options);

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
  if (commandName === "help") {
    const helpEmbed = new EmbedBuilder()
      .setTitle("Softcard Bot Commands")
      .setDescription(HELP_LINES.join("\n"))
      .setColor(0x62d26f)
      .setFooter({ text: "Cat care lives under /catcare so the system stays compact." });
    return interaction.reply({
      ephemeral: true,
      embeds: [helpEmbed],
    });
  }

  if (commandName === "cat") {
    const favoriteInput = options.getString("favorite");
    if (favoriteInput) {
      const cat = findCat(favoriteInput);
      if (!cat || getUserCatQuantity(user.id, cat.name) <= 0) {
        return interaction.reply({ content: `You do not own a cat matching "${favoriteInput}".`, ephemeral: true });
      }
      const currentCare = normalizedCare(user.id);
      saveCare(user.id, { ...careDefaults(cat.name), level: currentCare.level || 1, xp: currentCare.xp || 0 });
    }
    return interaction.reply({ ...(await catPanelPayload(interaction, "panel")), ephemeral: true });
  }

  if (commandName === "explore") {
    const remainingMs = getExploreCooldown(user.id);
    if (remainingMs > 0) {
      const remainingSeconds = Math.ceil(remainingMs / 1000);
      return interaction.reply({
        content: `You need to rest before exploring again. Try in **${Math.ceil(remainingSeconds / 60)}m ${remainingSeconds % 60}s**.`,
        ephemeral: true,
      });
    }

    setExploreCooldown(user.id);
    const foundItem = chooseWeighted(EXPLORE_ITEMS);
    addUserItem(user.id, foundItem.name, 1);

    const foundCat = Math.random() < 0.18;
    let catLine = "No cat followed you home this time.";
    if (foundCat) {
      const cat = chooseRandomCat();
      addUserCat(user.id, cat.name, 1);
      const rarity = CAT_RARITY_INFO[cat.rarity] || CAT_RARITY_INFO.Common;
      catLine = `A cat appeared too: ${cat.emoji} **${cat.name}** [${cat.rarity}] worth **${rarity.points}** points.`;
    }

    const items = getUserItems(user.id);
    const itemTotal = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const exploreEmbed = new EmbedBuilder()
      .setTitle(`${user.username} explored the alleys`)
      .addFields(
        { name: "Item found", value: `**${foundItem.name}** [${foundItem.rarity}]`, inline: true },
        { name: "Cat encounter", value: catLine, inline: false },
        { name: "Bag", value: `**${itemTotal}** total item${itemTotal === 1 ? "" : "s"}`, inline: true },
      )
      .setColor(foundCat ? 0xf5b942 : 0x62d26f);

    return interaction.reply({
      embeds: [exploreEmbed],
    });
  }

  if (commandName === "catcare") {
    const action = options.getSubcommand();
    let care = normalizedCare(user.id);

    if (action === "favorite") {
      const catInput = options.getString("cat", true);
      const cat = findCat(catInput);
      if (!cat || getUserCatQuantity(user.id, cat.name) <= 0) {
        return interaction.reply({ content: `You do not own a cat matching "${catInput}".`, ephemeral: true });
      }

      care = { ...careDefaults(cat.name), level: care.level || 1, xp: care.xp || 0 };
      saveCare(user.id, care);
      return interaction.reply({ embeds: [careEmbed(user, care, "Favorite cat selected")], ephemeral: true });
    }

    if (action === "bag") {
      const items = getUserItems(user.id);
      const embed = new EmbedBuilder()
        .setTitle(`${user.username}'s Explore Bag`)
        .setDescription(items.length ? items.map((item) => `**${item.name}** x \`${item.quantity}\``).join("\n") : "Your bag is empty. Use `/explore` to find food and upgrade items.")
        .setColor(0x62d26f);
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (!care.favoriteCat || getUserCatQuantity(user.id, care.favoriteCat) <= 0) {
      return interaction.reply({
        content: "Pick a favorite cat first with `/catcare favorite cat:<name>`.",
        ephemeral: true,
      });
    }

    if (action === "status") {
      return interaction.reply({ embeds: [careEmbed(user, care)], ephemeral: true });
    }

    if (action === "feed") {
      const requestedFood = options.getString("food") || "Cat Treat";
      const food = getUserItems(user.id).find((item) => item.name.toLowerCase() === requestedFood.toLowerCase() && CAT_FOOD_ITEMS.has(item.name))
        || getUserItems(user.id).find((item) => CAT_FOOD_ITEMS.has(item.name));
      if (!food) {
        return interaction.reply({ content: "You need food first. Explore for Cat Treats, Fish Snacks, or Ancient Catnip.", ephemeral: true });
      }

      removeUserItem(user.id, food.name, 1);
      care.hunger = Math.min(100, Number(care.hunger || 0) + (food.name === "Ancient Catnip" ? 45 : food.name === "Fish Snack" ? 30 : 22));
      care.happiness = Math.min(100, Number(care.happiness || 0) + 8);
      care.xp = Number(care.xp || 0) + 5;
      if (care.xp >= care.level * 25) {
        care.xp = 0;
        care.level += 1;
      }
      saveCare(user.id, care);
      return interaction.reply({ embeds: [careEmbed(user, care, `Fed ${care.favoriteCat} with ${food.name}`)], ephemeral: true });
    }

    if (action === "play") {
      const toy = getUserItemQuantity(user.id, "Yarn Ball") > 0 ? "Yarn Ball" : getUserItemQuantity(user.id, "Tiny Bell") > 0 ? "Tiny Bell" : "";
      if (!toy) return interaction.reply({ content: "You need a Yarn Ball or Tiny Bell from `/explore` to play.", ephemeral: true });

      removeUserItem(user.id, toy, 1);
      care.happiness = Math.min(100, Number(care.happiness || 0) + (toy === "Tiny Bell" ? 32 : 22));
      care.hunger = Math.max(0, Number(care.hunger || 0) - 6);
      care.xp = Number(care.xp || 0) + 6;
      if (care.xp >= care.level * 25) {
        care.xp = 0;
        care.level += 1;
      }
      saveCare(user.id, care);
      return interaction.reply({ embeds: [careEmbed(user, care, `Played with ${care.favoriteCat}`)], ephemeral: true });
    }

    if (action === "upgrade") {
      const currentCat = catRef(care.favoriteCat);
      const recipe = currentCat ? CAT_UPGRADE_RECIPES[currentCat.rarity] : null;
      if (!recipe) return interaction.reply({ embeds: [careEmbed(user, care, "This cat is already max rarity")], ephemeral: true });
      if (care.hunger < 60 || care.happiness < 60) {
        return interaction.reply({ content: "Your favorite cat needs at least 60 hunger and 60 happiness before upgrading.", ephemeral: true });
      }
      if (!consumeRecipeItems(user.id, recipe)) {
        return interaction.reply({ embeds: [careEmbed(user, care, "Missing upgrade items")], ephemeral: true });
      }

      const upgradedCat = randomCatByRarity(recipe.next);
      removeUserCat(user.id, currentCat.name, 1);
      addUserCat(user.id, upgradedCat.name, 1);
      care.favoriteCat = upgradedCat.name;
      care.hunger = Math.max(35, care.hunger - 25);
      care.happiness = Math.max(35, care.happiness - 20);
      care.level += 1;
      care.xp = 0;
      saveCare(user.id, care);
      return interaction.reply({ embeds: [careEmbed(user, care, `${currentCat.name} upgraded into ${upgradedCat.name}`)], ephemeral: true });
    }
  }

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
    if (state.stoppedCatServers) delete state.stoppedCatServers[guild.id];
    saveData(state);

    return interaction.reply({ content: `✅ **Success!** Cat drops configured in <#${chosenChannel.id}>.` });
  }

  if (commandName === "stopcat") {
    const guild = interaction.guild;
    if (!guild) return interaction.reply({ content: "This command must be used within a server.", ephemeral: true });
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: "You need Manage Server permission to stop cat drops.", ephemeral: true });
    }

    const state = loadData();
    state.stoppedCatServers = state.stoppedCatServers || {};
    state.stoppedCatServers[guild.id] = true;
    state.serverMessageCounters[guild.id] = 0;

    const configuredChannelId = state.serverSetups[guild.id];
    if (configuredChannelId) {
      const activeDrop = activeDrops.get(configuredChannelId);
      if (activeDrop?.timeoutId) clearTimeout(activeDrop.timeoutId);
      activeDrops.delete(configuredChannelId);
    }

    saveData(state);
    return interaction.reply({
      content: "Cat drops are now stopped for this server. Run `/serversetup` to turn them back on.",
      ephemeral: true,
    });
  }

  if (commandName === "pickup") {
    const activeCat = activeDrops.get(channelId);
    if (!activeCat) return interaction.reply({ content: "❌ There is no wild cat running around in this channel!", ephemeral: true });
    if (activeCat.expiresAt && Date.now() > activeCat.expiresAt) {
      activeDrops.delete(channelId);
      return interaction.reply({ content: "That cat already ran away.", ephemeral: true });
    }
    if (activeCat.timeoutId) clearTimeout(activeCat.timeoutId);

    activeDrops.delete(channelId);
    addUserCat(user.id, activeCat.name, 1);
    const rarity = CAT_RARITY_INFO[activeCat.rarity] || CAT_RARITY_INFO.Common;

    return interaction.reply({
      content: `**${user.username}** caught ${activeCat.emoji} **${activeCat.name}** [${activeCat.rarity}] for **${rarity.points}** points. Check \`/catstorage\`.`,
    });
  }

  if (commandName === "catstorage") {
    await interaction.deferReply({ ephemeral: true });
    const items = getUserInventory(user.id);

    if (items.length === 0) return interaction.editReply({ content: "📦 **Your Cat Storage vault is empty!**" });

    const stats = inventoryStats(items);
    let responseText = `**${user.username}'s Cat Vault**\n`;
    responseText += `Score: **${stats.score}** | Total: **${stats.totalCats}** | Unique: **${stats.uniqueCats}/${CATS.length}**\n\n`;
    responseText += items.slice(0, 35).map((item) => formatCat(item.cat_name, item.quantity)).join("\n");
    if (items.length > 35) responseText += `\n...and ${items.length - 35} more stacks.`;

    return interaction.editReply({ content: responseText });
  }

  if (commandName === "catdex") {
    await interaction.deferReply({ ephemeral: true });
    const items = getUserInventory(user.id);
    const owned = new Map(items.map((item) => [item.cat_name, Number(item.quantity || 0)]));
    const stats = inventoryStats(items);
    const rarityLines = Object.keys(CAT_RARITY_INFO).map((rarity) => {
      const rarityCats = CATS.filter((cat) => cat.rarity === rarity);
      const ownedCount = rarityCats.filter((cat) => owned.has(cat.name)).length;
      return `**${rarity}**: ${ownedCount}/${rarityCats.length} unique, ${stats.byRarity[rarity] || 0} total`;
    });

    return interaction.editReply({
      content: [
        `**${user.username}'s CatDex**`,
        `Collection: **${stats.uniqueCats}/${CATS.length}** unique | Score: **${stats.score}**`,
        "",
        ...rarityLines,
      ].join("\n"),
    });
  }

  if (commandName === "catleaderboard") {
    await interaction.deferReply();
    const rows = getLeaderboard(10);
    if (rows.length === 0) return interaction.editReply({ content: "No cat collectors yet." });

    const lines = await Promise.all(rows.map(async (row, index) => {
      const member = interaction.guild?.members.cache.get(row.userId) || await interaction.guild?.members.fetch(row.userId).catch(() => null);
      return `**${index + 1}.** ${member?.user?.username || row.userId} - **${row.score}** pts, ${row.uniqueCats}/${CATS.length} unique, ${row.totalCats} total`;
    }));

    return interaction.editReply({ content: `**Cat Collector Leaderboard**\n${lines.join("\n")}` });
  }

  if (commandName === "trade") {
    const targetUser = options.getUser("user");
    const yourCatInput = options.getString("your_cat").trim();
    const theirCatInput = options.getString("their_cat")?.trim() || "none";

    if (targetUser.id === user.id) return interaction.reply({ content: "❌ You cannot trade with yourself!", ephemeral: true });
    if (targetUser.bot) return interaction.reply({ content: "❌ You can't trade with bots!", ephemeral: true });

    const myMatch = findCat(yourCatInput);
    const myQuantity = myMatch ? getUserCatQuantity(user.id, myMatch.name) : 0;
    if (!myMatch || myQuantity <= 0) return interaction.reply({ content: `❌ You do not own a cat named "${yourCatInput}"!`, ephemeral: true });

    let theirMatch = null;
    const isGift = theirCatInput.toLowerCase() === "none";

    if (!isGift) {
      theirMatch = findCat(theirCatInput);
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
