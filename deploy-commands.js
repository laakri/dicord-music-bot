require("dotenv").config();
const {
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("chiko")
    .setDescription("Add local MP3s (or one) to the queue")
    .addStringOption((o) =>
      o
        .setName("song")
        .setDescription("Pick a song (leave empty to add every song)")
        .setAutocomplete(true),
    )
    .addBooleanOption((o) =>
      o.setName("shuffle").setDescription("Shuffle when adding all songs"),
    ),
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play one song from YouTube (link or search)")
    .addStringOption((o) =>
      o
        .setName("query")
        .setDescription("YouTube link or search words")
        .setRequired(true)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName("list")
    .setDescription(
      "Add popular songs for an artist or genre (or a playlist link)",
    )
    .addStringOption((o) =>
      o
        .setName("query")
        .setDescription(
          "Artist or genre, e.g. r&b, nermine sfar, or a playlist link",
        )
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addIntegerOption((o) =>
      o
        .setName("count")
        .setDescription("How many songs (default 10)")
        .setMinValue(3)
        .setMaxValue(25),
    )
    .addBooleanOption((o) =>
      o.setName("shuffle").setDescription("Shuffle the picked songs"),
    ),
  new SlashCommandBuilder().setName("help").setDescription("Show all commands"),
  new SlashCommandBuilder()
    .setName("favorites")
    .setDescription("Show your saved favorite songs"),
  new SlashCommandBuilder()
    .setName("unfavorite")
    .setDescription("Remove a song from your favorites")
    .addIntegerOption((o) =>
      o
        .setName("position")
        .setDescription("Position in /favorites")
        .setMinValue(1)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("gw")
    .setDescription(
      "Show every Fantasy Premier League match in the current gameweek",
    ),
  new SlashCommandBuilder()
    .setName("setremindchannel")
    .setDescription(
      "Post FPL deadline reminders (24h & 2h, tags @everyone) in this channel",
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName("testremind")
    .setDescription(
      "Send a sample FPL reminder now, to check it works (doesn't affect the real schedule)",
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("queue").setDescription("Show the queue"),
  new SlashCommandBuilder().setName("skip").setDescription("Skip current song"),
  new SlashCommandBuilder().setName("pause").setDescription("Pause playback"),
  new SlashCommandBuilder().setName("resume").setDescription("Resume playback"),
  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove a song from the queue")
    .addIntegerOption((o) =>
      o
        .setName("position")
        .setDescription("Position in /queue")
        .setMinValue(1)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Clear the queue (keeps the current song)"),
  new SlashCommandBuilder()
    .setName("shuffle")
    .setDescription("Shuffle the upcoming songs"),
  new SlashCommandBuilder()
    .setName("loop")
    .setDescription("Set loop mode")
    .addStringOption((o) =>
      o
        .setName("mode")
        .setDescription("Loop mode")
        .setRequired(true)
        .addChoices(
          { name: "Off", value: "off" },
          { name: "Current song", value: "song" },
          { name: "Whole queue", value: "queue" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop, clear the queue and leave"),
].map((c) => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

(async () => {
  try {
    console.log("Deploying commands...");
    await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID,
        process.env.GUILD_ID,
      ),
      { body: commands },
    );
    console.log("✅ Commands deployed");
  } catch (err) {
    console.error(err);
  }
})();
