require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Add a song (or all songs) to the queue")
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
    .setName("youtube")
    .setDescription("Play from YouTube (link or search)")
    .addStringOption((o) =>
      o
        .setName("query")
        .setDescription("YouTube link or search words")
        .setRequired(true)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName("mix")
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
