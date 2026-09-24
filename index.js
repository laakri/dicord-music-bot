require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  entersState,
  VoiceConnectionStatus,
} = require("@discordjs/voice");
const { spawn, execFile } = require("child_process");
const { PassThrough } = require("stream");
const fs = require("fs");
const path = require("path");

try {
  process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || require("ffmpeg-static");
} catch {}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const musicPath = path.join(__dirname, "music");
const IDLE_LEAVE_MS = 60_000;
const TICK_MS = 10_000; // how often the progress bar moves
const ACCENT = 0xfa243c;
const EPH = { flags: MessageFlags.Ephemeral };
const MAX_YT_SECONDS = 4 * 60 * 60; // refuse videos longer than 4h

// ---------- yt-dlp setup ----------
const localYtdlp = path.join(
  __dirname,
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
);
const YTDLP =
  process.env.YTDLP_PATH || (fs.existsSync(localYtdlp) ? localYtdlp : "yt-dlp");
const YTDLP_EXTRA = (process.env.YTDLP_ARGS || "").split(" ").filter(Boolean);

// Monochrome text glyphs (no colourful emoji). \uFE0E forces text style.
const ICON = {
  play: "\u25B6\uFE0E",
  pause: "\u275A\u275A",
  next: "\u23ED\uFE0E",
  shuffle: "\u21C4",
  loop: "\u21BB",
  stop: "\u25A0",
  fav: "\u2605\uFE0E",
};

// ============================================================
//  HELPERS
// ============================================================
const listSongs = () =>
  fs
    .readdirSync(musicPath)
    .filter((f) => /\.mp3$/i.test(f))
    .sort();

const pretty = (f) => f.replace(/\.mp3$/i, "");
const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

const shuffle = (arr) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

const fmt = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
};

const localItem = (file, by) => ({
  kind: "local",
  file,
  title: pretty(file),
  by,
});

// ============================================================
//  FAVORITES  (saved per Discord user, persisted to a JSON file)
// ============================================================
const dataDir = path.join(__dirname, "data");
const favPath = path.join(dataDir, "favorites.json");
const MAX_FAVORITES = 100;
let favorites = {}; // userId -> [{ kind, file|url, title, duration }]

function loadFavorites() {
  try {
    favorites = JSON.parse(fs.readFileSync(favPath, "utf8"));
  } catch {
    favorites = {};
  }
}
loadFavorites();

function saveFavorites() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(favPath, JSON.stringify(favorites, null, 2));
  } catch (err) {
    console.error("Failed to save favorites:", err.message);
  }
}

const favKey = (it) =>
  it.kind === "local" ? `local:${it.file}` : `yt:${it.url}`;

// Returns true if added, false if it was already saved (and got removed).
function toggleFavorite(userId, item) {
  const list = favorites[userId] || (favorites[userId] = []);
  const key = favKey(item);
  const idx = list.findIndex((f) => favKey(f) === key);
  if (idx >= 0) {
    list.splice(idx, 1);
    saveFavorites();
    return false;
  }
  if (list.length >= MAX_FAVORITES) return null; // full
  list.push({
    kind: item.kind,
    file: item.file,
    url: item.url,
    title: item.title,
    duration: item.duration ?? null,
  });
  saveFavorites();
  return true;
}

function favoritesText(userId) {
  const list = favorites[userId] || [];
  if (!list.length)
    return "You haven't saved any favorites yet. Use the star button while a song plays.";
  const lines = ["**Your favorites**"];
  list.forEach((f, i) =>
    lines.push(
      `${i + 1}.  ${clip(f.title, 70)}${f.kind === "yt" ? "  ·  YouTube" : ""}`,
    ),
  );
  return lines.join("\n");
}

// ============================================================
//  FANTASY PREMIER LEAGUE  (free public API, no key needed)
// ============================================================
const FPL_API = "https://fantasy.premierleague.com/api";
const FPL_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; discord-bot)" };
const FPL_CACHE_MS = 60_000;
const REMIND_CHECK_MS = 5 * 60_000;

const configPath = path.join(dataDir, "config.json"); // { remindChannelId }
const remindStatePath = path.join(dataDir, "remind-state.json"); // { [eventId]: { day, hour } }

let botConfig = {};
try {
  botConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  botConfig = {};
}
function saveConfig() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(botConfig, null, 2));
  } catch (err) {
    console.error("Failed to save config:", err.message);
  }
}

let remindState = {};
try {
  remindState = JSON.parse(fs.readFileSync(remindStatePath, "utf8"));
} catch {
  remindState = {};
}
function saveRemindState() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(remindStatePath, JSON.stringify(remindState, null, 2));
  } catch (err) {
    console.error("Failed to save reminder state:", err.message);
  }
}

let bootstrapCache = { data: null, ts: 0 };
async function fplFetch(pathPart) {
  const res = await fetch(`${FPL_API}${pathPart}`, { headers: FPL_HEADERS });
  if (!res.ok) throw new Error(`FPL API ${res.status}`);
  return res.json();
}

async function getBootstrap() {
  if (bootstrapCache.data && Date.now() - bootstrapCache.ts < FPL_CACHE_MS)
    return bootstrapCache.data;
  const data = await fplFetch("/bootstrap-static/");
  bootstrapCache = { data, ts: Date.now() };
  return data;
}

const getFixtures = (eventId) => fplFetch(`/fixtures/?event=${eventId}`);

const teamMap = (bootstrap) =>
  new Map(bootstrap.teams.map((t) => [t.id, t.short_name || t.name]));

const currentEvent = (bootstrap) =>
  bootstrap.events.find((e) => e.is_current) ||
  bootstrap.events.find((e) => e.is_next);

const nextDeadlineEvent = (bootstrap) =>
  bootstrap.events.find(
    (e) => !e.finished && new Date(e.deadline_time).getTime() > Date.now(),
  );

const tsSec = (iso) => Math.floor(new Date(iso).getTime() / 1000);

function formatMatchLine(fx, teams) {
  const h = teams.get(fx.team_h) || "TBD";
  const a = teams.get(fx.team_a) || "TBD";
  if (fx.finished)
    return `${h} ${fx.team_h_score}-${fx.team_a_score} ${a}   FT`;
  if (fx.started) {
    const min = fx.minutes ? `${fx.minutes}'` : "LIVE";
    return `${h} ${fx.team_h_score ?? 0}-${fx.team_a_score ?? 0} ${a}   ${min}`;
  }
  const kt = fx.kickoff_time ? `<t:${tsSec(fx.kickoff_time)}:f>` : "TBD";
  return `${h} vs ${a}   ${kt}`;
}

// Checked every 5 minutes. Posts once when the deadline crosses 24h left,
// and once more when it crosses 2h left, then never again for that gameweek.
async function checkDeadlineReminders() {
  if (!botConfig.remindChannelId) return;

  let bootstrap;
  try {
    bootstrap = await getBootstrap();
  } catch (err) {
    console.error("FPL reminder check failed:", err.message);
    return;
  }

  const next = nextDeadlineEvent(bootstrap);
  if (!next) return;

  const hoursLeft =
    (new Date(next.deadline_time).getTime() - Date.now()) / 3_600_000;
  const state = remindState[next.id] || (remindState[next.id] = {});
  const dl = tsSec(next.deadline_time);

  if (!state.day && hoursLeft <= 24) {
    await postReminder(
      `@everyone  **${next.name}** deadline is in about 24 hours — <t:${dl}:F> (<t:${dl}:R>). Set your team!`,
    );
    state.day = true;
    saveRemindState();
  }
  if (!state.hour && hoursLeft <= 2) {
    await postReminder(
      `@everyone  **${next.name}** locks in about 2 hours — <t:${dl}:R>. Last call!`,
    );
    state.hour = true;
    saveRemindState();
  }
}

async function postReminder(content) {
  try {
    const channel = await client.channels.fetch(botConfig.remindChannelId);
    await channel.send({ content, allowedMentions: { parse: ["everyone"] } });
  } catch (err) {
    console.error("Failed to post FPL reminder:", err.message);
  }
}

const durationCache = new Map();
async function getDuration(file) {
  if (durationCache.has(file)) return durationCache.get(file);
  let dur = null;
  try {
    const mm = await import("music-metadata");
    const meta = await mm.parseFile(path.join(musicPath, file), {
      duration: true,
    });
    dur = meta.format.duration ?? null;
  } catch {}
  durationCache.set(file, dur);
  return dur;
}

// ============================================================
//  YOUTUBE (via yt-dlp)
// ============================================================
function parseYouTubeInput(input) {
  const q = input.trim();
  if (!q) return { error: "Type a YouTube link or some search words." };

  if (/^https?:\/\//i.test(q)) {
    let u;
    try {
      u = new URL(q);
    } catch {
      return { error: "That link doesn't look valid." };
    }
    if (!/^(www\.|m\.|music\.)?(youtube\.com|youtu\.be)$/i.test(u.hostname)) {
      return { error: "Only YouTube links are supported." };
    }
    if (u.pathname === "/playlist")
      return { error: "That's a playlist. Use /list for playlists." };
    return { target: q };
  }
  return { target: `ytsearch1:${q}` };
}

function ytInfo(target) {
  return new Promise((resolve, reject) => {
    execFile(
      YTDLP,
      [
        "--dump-single-json",
        "--no-playlist",
        "--no-warnings",
        ...YTDLP_EXTRA,
        "--",
        target,
      ],
      { maxBuffer: 32 * 1024 * 1024, timeout: 45_000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          return reject(err);
        }
        try {
          const j = JSON.parse(stdout);
          resolve(j.entries ? j.entries[0] : j);
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

// ---------- /mix helpers ----------
const MIX_DEFAULT = 10;
const MAX_QUEUE = 200;

const MIX_PRESETS = [
  "R&B hits",
  "Hip hop hits",
  "Pop hits",
  "Rock classics",
  "Arabic hits",
  "Chill lofi",
  "Latin hits",
  "90s hits",
  "2000s hits",
  "Workout",
  "Party",
  "Jazz",
];

// Titles containing these words are skipped (compilations, covers, etc.)
// unless the user typed the word themselves.
const BAD_WORDS = [
  "mix",
  "playlist",
  "compilation",
  "mashup",
  "nonstop",
  "non stop",
  "full album",
  "hour",
  "hours",
  "live",
  "reaction",
  "tutorial",
  "karaoke",
  "instrumental",
  "cover",
  "remix",
  "slowed",
  "sped up",
  "nightcore",
  "8d",
  "reverb",
  "top 10",
  "top 20",
  "top 50",
  "best of",
];

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normTitle = (t) =>
  t
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(
      /\b(official|video|music|audio|lyrics?|lyric|hd|hq|4k|clip|explicit|ft|feat|featuring)\b/g,
      " ",
    )
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const validId = (id) => /^[\w-]{11}$/.test(id || "");

function parseMixInput(input) {
  const q = input.trim();
  if (!q) return { error: "Type an artist, a genre, or a playlist link." };

  if (/^https?:\/\//i.test(q)) {
    let u;
    try {
      u = new URL(q);
    } catch {
      return { error: "That link doesn't look valid." };
    }
    if (!/^(www\.|m\.|music\.)?(youtube\.com|youtu\.be)$/i.test(u.hostname)) {
      return { error: "Only YouTube links are supported." };
    }
    const list = u.searchParams.get("list");
    if (!list)
      return { error: "That link is a single video. Use /play for it." };
    return {
      kind: "playlist",
      target: `https://www.youtube.com/playlist?list=${encodeURIComponent(list)}`,
    };
  }
  return { kind: "search", query: q };
}

// Fast metadata-only listing (no format extraction)
function ytFlat(target, endN) {
  return new Promise((resolve, reject) => {
    const args = [
      "--flat-playlist",
      "--dump-single-json",
      "--no-warnings",
      ...(endN ? ["--playlist-end", String(endN)] : []),
      ...YTDLP_EXTRA,
      "--",
      target,
    ];
    execFile(
      YTDLP,
      args,
      { maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          return reject(err);
        }
        try {
          resolve(JSON.parse(stdout).entries || []);
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

// Keep real songs, drop junk/duplicates, then rank the best matches by views
function pickPopular(entries, query, count) {
  const q = query.toLowerCase();
  const bad = BAD_WORDS.filter((w) => !q.includes(w));
  const badRe = bad.length
    ? new RegExp(`\\b(${bad.map(escapeRe).join("|")})\\b`, "i")
    : null;

  const seen = new Set();
  const pool = [];
  for (const e of entries) {
    if (!e || !validId(e.id)) continue;
    const d = e.duration;
    if (!d || d < 60 || d > 600) continue; // real songs only: 1 to 10 minutes
    const title = e.title || "";
    if (badRe && badRe.test(title)) continue;
    const key = normTitle(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    pool.push(e);
  }

  // pool is in relevance order; rank the most relevant ones by popularity
  const top = pool.slice(0, Math.max(count * 3, 30));
  const withViews = top.filter((e) => e.view_count).length;
  if (top.length && withViews >= top.length / 2) {
    top.sort((a, b) => (b.view_count || 0) - (a.view_count || 0));
  }
  return top.slice(0, count);
}

const interleave = (a, b) => {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i]) out.push(a[i]);
    if (b[i]) out.push(b[i]);
  }
  return out;
};

// YouTube's own search suggestions (fast typing)
async function ytSuggest(q) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(
      `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(q)}`,
      { signal: ctrl.signal },
    );
    const json = await res.json();
    return (json[1] || []).filter((x) => typeof x === "string").slice(0, 10);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function helpEmbed() {
  return new EmbedBuilder()
    .setColor(ACCENT)
    .setAuthor({ name: "Help" })
    .setTitle("Join a voice channel, then pick a command")
    .addFields(
      {
        name: "Play",
        value:
          "`/chiko`  songs from the bot's own folder\n" +
          "`/play`  one song from YouTube (name or link)\n" +
          "`/list`  popular songs for an artist or genre, or a playlist link",
      },
      {
        name: "Control",
        value:
          "`/queue`  `/skip`  `/pause`  `/resume`  `/shuffle`\n" +
          "`/loop`  `/remove`  `/clear`  `/stop`",
      },
      {
        name: "Favorites",
        value:
          "Tap the star button on the player card to save or unsave the current song.\n" +
          "`/favorites`  view your saved songs, with a button to queue them all\n" +
          "`/unfavorite`  remove one by its number in `/favorites`",
      },
      {
        name: "Fantasy Premier League",
        value:
          "`/gw`  show every match in the current gameweek\n" +
          "`/setremindchannel`  post deadline reminders (24h & 2h, @everyone) in this channel\n" +
          "`/testremind`  send a sample reminder now, to check it works",
      },
      {
        name: "Tips",
        value:
          "Start typing and pick a suggestion.\n" +
          "`/list` adds 10 songs by default. Set `count` for 3 to 25.\n" +
          "The player card has buttons for shuffle, pause, skip, repeat, stop and favorite.",
      },
    );
}

function killProc(s) {
  const proc = s.proc;
  s.proc = null;
  if (!proc || proc.exitCode !== null) return;
  proc.killedByBot = true;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
        windowsHide: true,
      });
    } else {
      proc.kill("SIGKILL");
    }
  } catch {}
}

function makeResource(s, item) {
  if (item.kind === "local") {
    return createAudioResource(path.join(musicPath, item.file));
  }

  // YouTube: yt-dlp streams the audio to stdout, ffmpeg (inside @discordjs/voice) decodes it.
  // YouTube sometimes answers 403 at random, so if yt-dlp fails BEFORE any audio arrives
  // we quietly try again (up to MAX_TRIES) while the player just waits on the stream.
  const MAX_TRIES = 4;
  const out = new PassThrough();
  const args = [
    "-f",
    "bestaudio[ext=webm]/bestaudio/best",
    "--no-playlist",
    "--no-warnings",
    "-q",
    "-o",
    "-",
    ...YTDLP_EXTRA,
    "--",
    item.url,
  ];

  const launch = (attempt) => {
    const proc = spawn(YTDLP, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    s.proc = proc;

    let gotData = false;
    let errText = "";
    proc.stderr.on("data", (d) => {
      errText = (errText + d.toString()).slice(-2000);
    });
    proc.stdout.on("error", () => {});
    proc.stdout.once("data", () => {
      gotData = true;
    });
    proc.stdout.pipe(out, { end: false });
    proc.on("error", (e) => console.error("yt-dlp spawn error:", e.message));

    proc.on("close", (code) => {
      proc.stdout.unpipe(out);
      if (proc.killedByBot) return out.end();

      const reason = errText.trim().split("\n").slice(-2).join(" | ");

      if (code && !gotData && attempt < MAX_TRIES) {
        console.error(
          `yt-dlp failed (try ${attempt}/${MAX_TRIES}), retrying: ${reason}`,
        );
        return setTimeout(() => {
          if (s.proc !== proc) return out.end(); // track was skipped/stopped meanwhile
          launch(attempt + 1);
        }, 800);
      }

      if (code) {
        console.error(`yt-dlp exited with ${code}: ${reason}`);
        // short-lived notice, then it disappears (no chat history)
        s.channel
          ?.send(`Couldn't play **${clip(item.title, 80)}**. Skipping.`)
          .then((m) => setTimeout(() => m.delete().catch(() => {}), 10_000))
          .catch(() => {});
      }
      out.end();
    });
  };

  launch(1);
  return createAudioResource(out, { inputType: StreamType.Arbitrary });
}

// ============================================================
//  SESSIONS
// ============================================================
/**
 * item    = { kind: "local", file, title, by } | { kind: "yt", url, title, duration, by }
 * session = {
 *   connection, player, channel, proc,
 *   queue: item[], current: (item + duration)|null,
 *   loop: "off"|"song"|"queue", skipped, idleTimer, ticker,
 *   panel: Message|null, panelOps: Promise
 * }
 */
const sessions = new Map();

function destroySession(guildId) {
  const s = sessions.get(guildId);
  if (!s) return;
  sessions.delete(guildId);
  clearTimeout(s.idleTimer);
  clearInterval(s.ticker);
  deletePanel(s);
  s.player.removeAllListeners();
  s.player.stop(true);
  killProc(s);
  try {
    s.connection.destroy();
  } catch {}
}

// ============================================================
//  PANEL  (one message, edited in place)
// ============================================================
const isPaused = (s) =>
  [AudioPlayerStatus.Paused, AudioPlayerStatus.AutoPaused].includes(
    s.player.state.status,
  );

const elapsedSec = (s) =>
  s.player.state.resource
    ? Math.floor(s.player.state.resource.playbackDuration / 1000)
    : 0;

// ━━━━●─────
function progressBar(elapsed, total) {
  const SLOTS = 14;
  let idx;
  if (total) {
    idx = Math.min(SLOTS - 1, Math.floor((elapsed / total) * SLOTS));
  } else {
    const cycle = SLOTS * 2 - 2; // unknown length: knob glides back and forth
    idx = Math.floor(elapsed / 2) % cycle;
    if (idx >= SLOTS) idx = cycle - idx;
  }
  return "━".repeat(idx) + "●" + "─".repeat(SLOTS - 1 - idx);
}

function buildPanel(s) {
  if (!s.current) {
    const embed = new EmbedBuilder()
      .setColor(ACCENT)
      .setAuthor({ name: "Queue ended" })
      .setDescription("Use `/chiko`, `/play` or `/list` to add more.");
    return { embeds: [embed], components: [] };
  }

  const { title, by, duration, kind } = s.current;
  const el = elapsedSec(s);
  const paused = isPaused(s);

  const bar = progressBar(el, duration);
  const timeLine = duration
    ? `${fmt(el)}   ${bar}   ${fmt(duration)}`
    : `${fmt(el)}   ${bar}`;

  const footerParts = [`Requested by ${by}`];
  if (kind === "yt") footerParts.push("YouTube");
  if (s.loop === "song") footerParts.push("Repeat one");
  if (s.loop === "queue") footerParts.push("Repeat all");

  const embed = new EmbedBuilder()
    .setColor(ACCENT)
    .setAuthor({ name: paused ? "Paused" : "Now Playing" })
    .setTitle(clip(title, 250))
    .setDescription(timeLine)
    .setFooter({ text: footerParts.join("  ·  ") });

  if (s.queue.length) {
    const next = s.queue
      .slice(0, 3)
      .map((q, i) => `${i + 1}.  ${clip(q.title, 60)}`);
    if (s.queue.length > 3) next.push(`+${s.queue.length - 3} more`);
    embed.addFields({ name: "Up Next", value: next.join("\n") });
  }

  const btn = (id, label, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(`dj:${id}`).setLabel(label).setStyle(style);

  const row = new ActionRowBuilder().addComponents(
    btn("shuffle", ICON.shuffle),
    btn("toggle", paused ? ICON.play : ICON.pause, ButtonStyle.Primary),
    btn("skip", ICON.next),
    btn(
      "loop",
      s.loop === "song" ? `${ICON.loop} 1` : ICON.loop,
      s.loop === "off" ? ButtonStyle.Secondary : ButtonStyle.Success,
    ),
    btn("stop", ICON.stop),
  );
  const row2 = new ActionRowBuilder().addComponents(
    btn("fav", `${ICON.fav} Favorite`),
  );

  return { embeds: [embed], components: [row, row2] };
}

// Panel operations are chained so they never race each other.
function enqueuePanel(s, fn) {
  s.panelOps = s.panelOps
    .then(fn)
    .catch((e) => console.error("Panel error:", e.message));
}

// Fresh panel at the bottom of the chat; the old one is deleted
function sendPanel(s) {
  enqueuePanel(s, async () => {
    const old = s.panel;
    s.panel = null;
    old?.delete().catch(() => {});
    s.panel = await s.channel.send(buildPanel(s));
  });
}

// Edit the existing panel in place
function refreshPanel(s) {
  enqueuePanel(s, async () => {
    if (s.panel) {
      try {
        await s.panel.edit(buildPanel(s));
        return;
      } catch {
        s.panel = null;
      }
    }
    s.panel = await s.channel.send(buildPanel(s));
  });
}

function deletePanel(s) {
  enqueuePanel(s, async () => {
    const p = s.panel;
    s.panel = null;
    await p?.delete().catch(() => {});
  });
}

// ============================================================
//  QUEUE ENGINE
// ============================================================
function playNext(guildId) {
  const s = sessions.get(guildId);
  if (!s) return;
  clearTimeout(s.idleTimer);
  killProc(s); // stop any yt-dlp left over from the previous track

  const skipped = s.skipped;
  s.skipped = false;

  let next;
  let repeating = false;

  if (s.current && s.loop === "song" && !skipped) {
    next = s.current;
    repeating = true;
  } else {
    if (s.current && s.loop === "queue") s.queue.push({ ...s.current });
    next = s.queue.shift();
  }

  if (!next) {
    s.current = null;
    refreshPanel(s);
    s.idleTimer = setTimeout(() => destroySession(guildId), IDLE_LEAVE_MS);
    return;
  }

  const cur = {
    ...next,
    duration: next.kind === "yt" ? (next.duration ?? null) : null,
  };
  s.current = cur;
  s.player.play(makeResource(s, cur));

  if (!repeating) {
    const durationPromise =
      cur.kind === "yt" ? Promise.resolve(cur.duration) : getDuration(cur.file);
    durationPromise.then((d) => {
      if (sessions.get(guildId) !== s || s.current !== cur) return;
      cur.duration = d;
      sendPanel(s);
    });
  }
}

async function createSession(interaction, voiceChannel) {
  const guildId = interaction.guildId;

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    console.error("Voice join failed:", err.message);
    connection.destroy();
    return null;
  }

  const player = createAudioPlayer();
  connection.subscribe(player);

  const s = {
    connection,
    player,
    channel: interaction.channel,
    proc: null,
    queue: [],
    current: null,
    loop: "off",
    skipped: false,
    idleTimer: null,
    ticker: null,
    panel: null,
    panelOps: Promise.resolve(),
  };
  sessions.set(guildId, s);

  s.ticker = setInterval(() => {
    if (s.current && s.player.state.status === AudioPlayerStatus.Playing)
      refreshPanel(s);
  }, TICK_MS);

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      destroySession(guildId);
    }
  });

  player.on(AudioPlayerStatus.Idle, () => playNext(guildId));
  player.on("error", (err) => console.error("Player error:", err.message)); // Idle follows

  return s;
}

// Reuse the guild's session, or join the user's channel
async function ensureSession(interaction, voiceChannel) {
  let s = sessions.get(interaction.guildId);
  if (s) {
    if (s.connection.joinConfig.channelId !== voiceChannel.id) {
      return { error: "I'm already playing in another voice channel." };
    }
    s.channel = interaction.channel;
    return { s };
  }
  s = await createSession(interaction, voiceChannel);
  return s ? { s } : { error: "Failed to join the voice channel." };
}

// ============================================================
//  ACTIONS (shared by slash commands and buttons)
// ============================================================
function setPaused(s, pause) {
  if (pause) s.player.pause();
  else s.player.unpause();
  refreshPanel(s);
}

function skipSong(s) {
  if (!s.current) return false;
  s.skipped = true;
  s.player.stop(); // Idle -> playNext -> fresh panel
  return true;
}

function shuffleQueue(s) {
  if (s.queue.length < 2) return false;
  shuffle(s.queue);
  refreshPanel(s);
  return true;
}

function setLoop(s, mode) {
  s.loop = mode;
  refreshPanel(s);
}

function queueText(s) {
  const lines = [
    s.current
      ? `**Now playing**\n${clip(s.current.title, 80)}`
      : "**Now playing**\nNothing",
  ];
  if (s.loop !== "off")
    lines.push(`Repeat: ${s.loop === "song" ? "one" : "all"}`);
  if (!s.queue.length) {
    lines.push("\nThe queue is empty.");
  } else {
    lines.push("\n**Up next**");
    s.queue
      .slice(0, 20)
      .forEach((q, i) =>
        lines.push(`${i + 1}.  ${clip(q.title, 70)}  ·  ${q.by}`),
      );
    if (s.queue.length > 20) lines.push(`+${s.queue.length - 20} more`);
  }
  return lines.join("\n");
}

// ============================================================
//  EVENTS
// ============================================================
client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(
    `yt-dlp: ${YTDLP}${YTDLP_EXTRA.length ? "  args: " + YTDLP_EXTRA.join(" ") : ""}`,
  );

  checkDeadlineReminders(); // run once now (covers reminders missed while the bot was offline)
  setInterval(checkDeadlineReminders, REMIND_CHECK_MS);
});

client.on("interactionCreate", async (interaction) => {
  // ---------- autocomplete ----------
  if (interaction.isAutocomplete()) {
    try {
      const focused = interaction.options.getFocused(true);
      const cmd = interaction.commandName;

      if (cmd === "chiko" && focused.name === "song") {
        const typed = focused.value.toLowerCase();
        const choices = listSongs()
          .filter((f) => f.length <= 100 && f.toLowerCase().includes(typed))
          .slice(0, 25)
          .map((f) => ({ name: clip(pretty(f), 100), value: f }));
        return await interaction.respond(choices);
      }

      if ((cmd === "play" || cmd === "list") && focused.name === "query") {
        const typed = focused.value.trim();
        let list = [];
        if (!typed) list = cmd === "list" ? MIX_PRESETS : [];
        else if (!/^https?:\/\//i.test(typed)) list = await ytSuggest(typed);

        // the exact text typed always comes first, so Enter uses what you wrote
        const all = [
          ...new Set(
            typed && !/^https?:\/\//i.test(typed) ? [typed, ...list] : list,
          ),
        ];
        return await interaction.respond(
          all
            .slice(0, 25)
            .map((v) => ({ name: clip(v, 100), value: clip(v, 100) })),
        );
      }
    } catch (err) {
      console.error("Autocomplete error:", err.message);
      interaction.respond([]).catch(() => {});
    }
    return;
  }

  // ---------- panel buttons ----------
  if (interaction.isButton() && interaction.customId.startsWith("dj:")) {
    const s = sessions.get(interaction.guildId);
    if (!s)
      return interaction.reply({ content: "Nothing is playing.", ...EPH });

    const action = interaction.customId.slice(3);

    // Favoriting doesn't touch playback, so it doesn't require being in the voice channel.
    if (action === "fav") {
      if (!s.current)
        return interaction.reply({ content: "Nothing is playing.", ...EPH });
      const result = toggleFavorite(interaction.user.id, s.current);
      const msg =
        result === null
          ? `Your favorites are full (${MAX_FAVORITES}). Remove one with \`/unfavorite\` first.`
          : result
            ? `Added **${clip(s.current.title, 60)}** to your favorites.`
            : `Removed **${clip(s.current.title, 60)}** from your favorites.`;
      return interaction.reply({ content: msg, ...EPH });
    }

    if (
      interaction.member.voice.channelId !== s.connection.joinConfig.channelId
    ) {
      return interaction.reply({
        content: "Join my voice channel to use the controls.",
        ...EPH,
      });
    }

    await interaction.deferUpdate();

    switch (action) {
      case "toggle":
        if (s.current) setPaused(s, !isPaused(s));
        break;
      case "skip":
        skipSong(s);
        break;
      case "shuffle":
        if (!shuffleQueue(s))
          interaction.followUp({
            content: "Not enough songs to shuffle.",
            ...EPH,
          });
        break;
      case "loop": {
        const order = ["off", "queue", "song"];
        setLoop(s, order[(order.indexOf(s.loop) + 1) % order.length]);
        break;
      }
      case "stop":
        destroySession(interaction.guildId);
        break;
    }
    return;
  }

  // ---------- favorites: "Play all" button on the /favorites card ----------
  if (interaction.isButton() && interaction.customId === "fav:playall") {
    const list = (favorites[interaction.user.id] || []).filter(
      (f) => f.kind !== "local" || fs.existsSync(path.join(musicPath, f.file)),
    );
    if (!list.length)
      return interaction.reply({ content: "No favorites saved yet.", ...EPH });

    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel)
      return interaction.reply({
        content: "Join a voice channel first.",
        ...EPH,
      });

    await interaction.deferUpdate();

    const { s, error } = await ensureSession(interaction, voiceChannel);
    if (error) return interaction.followUp({ content: error, ...EPH });

    const room = MAX_QUEUE - s.queue.length;
    if (room <= 0)
      return interaction.followUp({ content: "The queue is full.", ...EPH });

    const who = interaction.member.displayName;
    const items = list
      .slice(0, room)
      .map((f) =>
        f.kind === "local"
          ? localItem(f.file, who)
          : {
              kind: "yt",
              url: f.url,
              title: f.title,
              duration: f.duration ?? null,
              by: who,
            },
      );

    s.queue.push(...items);
    clearTimeout(s.idleTimer);
    await interaction.followUp({
      content: `Added **${items.length}** favorite song(s) to the queue.`,
      ...EPH,
    });

    if (!s.current) playNext(interaction.guildId);
    else refreshPanel(s);
    return;
  }

  if (!interaction.isChatInputCommand() || !interaction.guildId) return;

  const { commandName, guildId } = interaction;
  const who = interaction.member.displayName;

  // ---------- /chiko (local files) ----------
  if (commandName === "chiko") {
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
      return interaction.reply({
        content: "Join a voice channel first.",
        ...EPH,
      });
    }

    let allFiles;
    try {
      allFiles = listSongs();
    } catch {
      return interaction.reply({
        content: "The `music` folder was not found.",
        ...EPH,
      });
    }
    if (!allFiles.length)
      return interaction.reply({ content: "No MP3 files found.", ...EPH });

    let toAdd;
    const song = interaction.options.getString("song");
    if (song) {
      const match = allFiles.find(
        (f) => f.toLowerCase() === song.toLowerCase(),
      );
      if (!match) {
        return interaction.reply({
          content: "Song not found. Pick one from the suggestions.",
          ...EPH,
        });
      }
      toAdd = [match];
    } else {
      toAdd = [...allFiles];
      if (interaction.options.getBoolean("shuffle")) shuffle(toAdd);
    }

    await interaction.deferReply(EPH);

    const { s, error } = await ensureSession(interaction, voiceChannel);
    if (error) return interaction.editReply(error);

    s.queue.push(...toAdd.map((file) => localItem(file, who)));
    clearTimeout(s.idleTimer);

    await interaction.editReply(
      toAdd.length === 1
        ? `Added **${pretty(toAdd[0])}** to the queue.`
        : `Added **${toAdd.length}** songs to the queue.`,
    );

    if (!s.current) playNext(guildId);
    else refreshPanel(s);
    return;
  }

  // ---------- /play (single YouTube song) ----------
  if (commandName === "play") {
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
      return interaction.reply({
        content: "Join a voice channel first.",
        ...EPH,
      });
    }

    const parsed = parseYouTubeInput(interaction.options.getString("query"));
    if (parsed.error)
      return interaction.reply({ content: parsed.error, ...EPH });

    await interaction.deferReply(EPH);

    let info;
    try {
      info = await ytInfo(parsed.target);
    } catch (err) {
      console.error("yt-dlp info error:", err.stderr || err.message);
      if (err.code === "ENOENT") {
        return interaction.editReply(
          "yt-dlp is not installed on the bot's machine. See the setup notes.",
        );
      }
      return interaction.editReply(
        "Couldn't load that video. Try another link or different words.",
      );
    }

    if (!info || !info.id) return interaction.editReply("No results found.");
    if (info.duration && info.duration > MAX_YT_SECONDS) {
      return interaction.editReply("That video is too long (max 4 hours).");
    }

    const { s, error } = await ensureSession(interaction, voiceChannel);
    if (error) return interaction.editReply(error);

    const item = {
      kind: "yt",
      url: `https://www.youtube.com/watch?v=${info.id}`,
      title: info.title || "Unknown title",
      duration: info.duration || null,
      by: who,
    };

    s.queue.push(item);
    clearTimeout(s.idleTimer);

    await interaction.editReply(
      `Added **${clip(item.title, 100)}**${item.duration ? ` (${fmt(item.duration)})` : ""} to the queue.`,
    );

    if (!s.current) playNext(guildId);
    else refreshPanel(s);
    return;
  }

  // ---------- /help ----------
  if (commandName === "help") {
    return interaction.reply({ embeds: [helpEmbed()], ...EPH });
  }

  // ---------- /gw (current gameweek scoreboard) ----------
  if (commandName === "gw") {
    await interaction.deferReply();

    let bootstrap;
    try {
      bootstrap = await getBootstrap();
    } catch (err) {
      console.error("FPL /gw error:", err.message);
      return interaction.editReply(
        "Couldn't reach the FPL servers. Try again in a bit.",
      );
    }

    const event = currentEvent(bootstrap);
    if (!event) return interaction.editReply("No active gameweek right now.");

    let fixtures;
    try {
      fixtures = await getFixtures(event.id);
    } catch (err) {
      console.error("FPL /gw fixtures error:", err.message);
      return interaction.editReply(
        "Couldn't load fixtures. Try again in a bit.",
      );
    }
    if (!fixtures.length)
      return interaction.editReply("No fixtures found for this gameweek.");

    const teams = teamMap(bootstrap);
    fixtures.sort(
      (a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time),
    );
    const lines = fixtures.map((fx) => formatMatchLine(fx, teams));

    const embed = new EmbedBuilder()
      .setColor(ACCENT)
      .setAuthor({ name: event.name })
      .setDescription("```\n" + lines.join("\n") + "\n```");

    return interaction.editReply({ embeds: [embed] });
  }

  // ---------- /setremindchannel ----------
  if (commandName === "setremindchannel") {
    botConfig.remindChannelId = interaction.channelId;
    saveConfig();
    return interaction.reply({
      content:
        "FPL deadline reminders (24h and 2h before, tagging @everyone) will be posted in this channel.",
      ...EPH,
    });
  }

  // ---------- /testremind ----------
  if (commandName === "testremind") {
    if (!botConfig.remindChannelId) {
      return interaction.reply({
        content:
          "No reminder channel is set yet. Run `/setremindchannel` first.",
        ...EPH,
      });
    }

    await interaction.deferReply(EPH);

    let bootstrap;
    try {
      bootstrap = await getBootstrap();
    } catch (err) {
      console.error("FPL /testremind error:", err.message);
      return interaction.editReply(
        "Couldn't reach the FPL servers. Try again in a bit.",
      );
    }

    const next = nextDeadlineEvent(bootstrap);
    const info = next
      ? `**${next.name}** deadline: <t:${tsSec(next.deadline_time)}:F> (<t:${tsSec(next.deadline_time)}:R>)`
      : "No upcoming deadline found right now.";

    try {
      const channel = await client.channels.fetch(botConfig.remindChannelId);
      await channel.send({
        content: `@everyone  **Test reminder** — this is only a test, not a real deadline alert.\n${info}`,
        allowedMentions: { parse: ["everyone"] },
      });
    } catch (err) {
      console.error("Test reminder send failed:", err.message);
      return interaction.editReply(
        `Couldn't send to <#${botConfig.remindChannelId}>. Make sure the bot has View Channel, Send Messages and Mention Everyone there.`,
      );
    }

    return interaction.editReply(
      `Sent a test reminder to <#${botConfig.remindChannelId}>. The real 24h/2h schedule is unaffected.`,
    );
  }

  // ---------- /favorites ----------
  if (commandName === "favorites") {
    const list = favorites[interaction.user.id] || [];
    const row = list.length
      ? [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("fav:playall")
              .setLabel("Add all to queue")
              .setStyle(ButtonStyle.Primary),
          ),
        ]
      : [];
    return interaction.reply({
      content: favoritesText(interaction.user.id),
      components: row,
      ...EPH,
    });
  }

  // ---------- /unfavorite ----------
  if (commandName === "unfavorite") {
    const list = favorites[interaction.user.id] || [];
    const pos = interaction.options.getInteger("position");
    if (pos > list.length) {
      return interaction.reply({
        content: `You only have ${list.length} favorite(s).`,
        ...EPH,
      });
    }
    const [removed] = list.splice(pos - 1, 1);
    saveFavorites();
    return interaction.reply({
      content: `Removed **${clip(removed.title, 60)}** from your favorites.`,
      ...EPH,
    });
  }

  // ---------- /list (mix / playlist) ----------
  if (commandName === "list") {
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
      return interaction.reply({
        content: "Join a voice channel first.",
        ...EPH,
      });
    }

    const parsed = parseMixInput(interaction.options.getString("query"));
    if (parsed.error)
      return interaction.reply({ content: parsed.error, ...EPH });

    const count = interaction.options.getInteger("count") ?? MIX_DEFAULT;

    await interaction.deferReply(EPH);

    let picked = [];
    try {
      if (parsed.kind === "playlist") {
        const entries = await ytFlat(parsed.target, count + 10);
        picked = entries
          .filter(
            (e) =>
              e &&
              validId(e.id) &&
              !/^\[(deleted|private) video\]$/i.test(e.title || ""),
          )
          .slice(0, count);
      } else {
        const results = await Promise.allSettled([
          ytFlat(`ytsearch25:${parsed.query} official music video`),
          ytFlat(`ytsearch25:${parsed.query} songs`),
        ]);
        const ok = results
          .filter((r) => r.status === "fulfilled")
          .map((r) => r.value);
        if (!ok.length) throw results[0].reason;

        const merged = ok.length === 2 ? interleave(ok[0], ok[1]) : ok[0];
        const unique = [...new Map(merged.map((e) => [e.id, e])).values()];
        picked = pickPopular(unique, parsed.query, count);
      }
    } catch (err) {
      console.error("yt-dlp mix error:", err.stderr || err.message);
      if (err.code === "ENOENT") {
        return interaction.editReply(
          "yt-dlp is not installed on the bot's machine. See the setup notes.",
        );
      }
      return interaction.editReply(
        "Couldn't load songs for that. Try different words.",
      );
    }

    if (!picked.length)
      return interaction.editReply("No songs found for that.");

    let items = picked.map((e) => ({
      kind: "yt",
      url: `https://www.youtube.com/watch?v=${e.id}`,
      title: e.title || "Unknown title",
      duration: e.duration || null,
      by: who,
    }));
    if (interaction.options.getBoolean("shuffle")) shuffle(items);

    const { s, error } = await ensureSession(interaction, voiceChannel);
    if (error) return interaction.editReply(error);

    const room = MAX_QUEUE - s.queue.length;
    if (room <= 0) return interaction.editReply("The queue is full.");
    items = items.slice(0, room);

    s.queue.push(...items);
    clearTimeout(s.idleTimer);

    const label =
      parsed.kind === "playlist"
        ? "from that playlist"
        : `for **${clip(parsed.query, 40)}**`;
    await interaction.editReply(`Added **${items.length}** songs ${label}.`);

    if (!s.current) playNext(guildId);
    else refreshPanel(s);
    return;
  }

  // ---------- commands that need a session ----------
  const s = sessions.get(guildId);
  if (!s) return interaction.reply({ content: "Nothing is playing.", ...EPH });

  switch (commandName) {
    case "queue":
      return interaction.reply({ content: queueText(s), ...EPH });

    case "skip":
      if (!skipSong(s))
        return interaction.reply({ content: "Nothing to skip.", ...EPH });
      return interaction.reply({ content: "Skipped.", ...EPH });

    case "pause":
      if (!s.current)
        return interaction.reply({ content: "Nothing is playing.", ...EPH });
      setPaused(s, true);
      return interaction.reply({ content: "Paused.", ...EPH });

    case "resume":
      if (!s.current)
        return interaction.reply({ content: "Nothing is playing.", ...EPH });
      setPaused(s, false);
      return interaction.reply({ content: "Resumed.", ...EPH });

    case "remove": {
      const pos = interaction.options.getInteger("position");
      if (pos > s.queue.length) {
        return interaction.reply({
          content: `The queue only has ${s.queue.length} song(s).`,
          ...EPH,
        });
      }
      const [removed] = s.queue.splice(pos - 1, 1);
      refreshPanel(s);
      return interaction.reply({
        content: `Removed **${removed.title}**.`,
        ...EPH,
      });
    }

    case "clear":
      s.queue = [];
      refreshPanel(s);
      return interaction.reply({ content: "Queue cleared.", ...EPH });

    case "shuffle":
      if (!shuffleQueue(s)) {
        return interaction.reply({
          content: "Not enough songs to shuffle.",
          ...EPH,
        });
      }
      return interaction.reply({ content: "Queue shuffled.", ...EPH });

    case "loop": {
      const mode = interaction.options.getString("mode");
      setLoop(s, mode);
      return interaction.reply({
        content: `Repeat set to **${mode}**.`,
        ...EPH,
      });
    }

    case "stop":
      destroySession(guildId);
      return interaction.reply({ content: "Stopped.", ...EPH });
  }
});

client.login(process.env.TOKEN);
