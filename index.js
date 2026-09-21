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
      return { error: "That's a playlist. Use /mix for playlists." };
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
      return { error: "That link is a single video. Use /youtube for it." };
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
          "`/play`  songs from the bot's own folder\n" +
          "`/youtube`  one song from YouTube (name or link)\n" +
          "`/mix`  popular songs for an artist or genre, or a playlist link",
      },
      {
        name: "Control",
        value:
          "`/queue`  `/skip`  `/pause`  `/resume`  `/shuffle`\n" +
          "`/loop`  `/remove`  `/clear`  `/stop`",
      },
      {
        name: "Tips",
        value:
          "Start typing and pick a suggestion.\n" +
          "`/mix` adds 10 songs by default. Set `count` for 3 to 25.\n" +
          "The player card has buttons for shuffle, pause, skip, repeat and stop.",
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
      .setDescription("Use `/play`, `/youtube` or `/mix` to add more.");
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

  return { embeds: [embed], components: [row] };
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
});

client.on("interactionCreate", async (interaction) => {
  // ---------- autocomplete ----------
  if (interaction.isAutocomplete()) {
    try {
      const focused = interaction.options.getFocused(true);
      const cmd = interaction.commandName;

      if (cmd === "play" && focused.name === "song") {
        const typed = focused.value.toLowerCase();
        const choices = listSongs()
          .filter((f) => f.length <= 100 && f.toLowerCase().includes(typed))
          .slice(0, 25)
          .map((f) => ({ name: clip(pretty(f), 100), value: f }));
        return await interaction.respond(choices);
      }

      if ((cmd === "youtube" || cmd === "mix") && focused.name === "query") {
        const typed = focused.value.trim();
        let list = [];
        if (!typed) list = cmd === "mix" ? MIX_PRESETS : [];
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

    if (
      interaction.member.voice.channelId !== s.connection.joinConfig.channelId
    ) {
      return interaction.reply({
        content: "Join my voice channel to use the controls.",
        ...EPH,
      });
    }

    await interaction.deferUpdate();

    switch (interaction.customId.slice(3)) {
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

  if (!interaction.isChatInputCommand() || !interaction.guildId) return;

  const { commandName, guildId } = interaction;
  const who = interaction.member.displayName;

  // ---------- /play (local files) ----------
  if (commandName === "play") {
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

  // ---------- /youtube ----------
  if (commandName === "youtube") {
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

  // ---------- /mix ----------
  if (commandName === "mix") {
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
