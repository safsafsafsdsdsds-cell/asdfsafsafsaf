require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  Events,
  REST,
  Routes,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  MessageFlags,
  ChannelType,
} = require("discord.js");

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  entersState,
} = require("@discordjs/voice");

const { spawn, spawnSync } = require("child_process");
const { existsSync } = require("fs");
const path = require("path");
const yts = require("yt-search");

const TOKEN          = process.env.DISCORD_TOKEN;
const CLIENT_ID      = process.env.CLIENT_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error("❌  กรุณาตั้งค่า DISCORD_TOKEN และ CLIENT_ID ใน .env");
  process.exit(1);
}

if (!LOG_CHANNEL_ID) {
  console.warn("⚠️  ไม่ได้ตั้งค่า LOG_CHANNEL_ID — การ์ดจะถูกส่งในห้องคำสั่งแทน");
}

const IS_COMPONENTS_V2 = 1 << 15;
const IS_WINDOWS       = process.platform === "win32";

const FLAGS = {
  V2          : IS_COMPONENTS_V2,
  V2_EPHEMERAL: IS_COMPONENTS_V2 | MessageFlags.Ephemeral,
};

const BLACK = 0x000000;

const MUSIC_CONFIG = {
  VOICE_CHANNEL_NAME: "🎵 Vendetta Shop",
  TEXT_CHANNEL_NAME : "🎵・music-commands-Vendetta Shop",
  CATEGORY_NAME     : "🎵 Music-Vendetta Shop",
};

const SEARCH_PAGE_SIZE = 10; 
const MENU_EMOJI = { id: "1457664481466257479", name: "prettyarrowr", animated: true }; 
const PREV_EMOJI = { id: "1457663782376575016", name: "arrow", animated: true };        
const NEXT_EMOJI = { id: "1457663782376575016", name: "arrow", animated: true };         

function findBinary(name) {
  const exeSuffix = IS_WINDOWS ? ".exe" : "";
  const localCandidates = [
    path.join(__dirname, `${name}${exeSuffix}`),
    path.join(__dirname, "bin", `${name}${exeSuffix}`),
    path.join(process.cwd(), `${name}${exeSuffix}`),
    path.join(process.cwd(), "bin", `${name}${exeSuffix}`),
  ];
  for (const c of localCandidates) {
    if (existsSync(c)) return c;
  }
  const checkCmd = IS_WINDOWS ? "where" : "which";
  const result = spawnSync(checkCmd, [name], { stdio: ["ignore", "pipe", "ignore"] });
  if (result.status === 0) return name;
  return null;
}

const YTDLP_CMD  = findBinary("yt-dlp");
const FFMPEG_CMD = findBinary("ffmpeg");

console.log(`\n🔍 yt-dlp : ${YTDLP_CMD || "❌ ไม่พบ"}`);
console.log(`🔍 ffmpeg : ${FFMPEG_CMD || "❌ ไม่พบ"}\n`);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

class MusicQueue {
  constructor(guildId) {
    this.guildId        = guildId;
    this.songs          = [];
    this.currentIdx     = 0;
    this.loop           = false;
    this.loopQueue      = false;
    this.volume         = 70;
    this.isPlaying      = false;
    this.stopped        = false;
    this.player         = null;
    this.connection     = null;
    this.resource       = null;
    this.textChannel    = null;
    this._destroyTimer  = null;
    this._progressTimer = null;
    this.startedAt      = 0;
    this.nowPlayingMsg  = null;
    this.pausedAt       = 0;
    this.totalPaused    = 0;
    this.isBuffering    = false;
    this._retried       = false;
  }

  add(song)     { this.songs.push(song); }
  get current() { return this.songs[this.currentIdx] || null; }
  get upcoming(){ return this.songs.slice(this.currentIdx + 1); }

  next() {
    if (this.loop) return this.songs[this.currentIdx];
    if (this.loopQueue && this.songs.length > 0) {
      this.currentIdx = (this.currentIdx + 1) % this.songs.length;
      return this.songs[this.currentIdx];
    }
    this.currentIdx++;
    return this.songs[this.currentIdx] || null;
  }

  shuffle() {
    if (this.songs.length <= 1) return;
    const cur  = this.songs[this.currentIdx];
    const rest = this.songs.filter((_, i) => i !== this.currentIdx);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    this.songs      = [cur, ...rest];
    this.currentIdx = 0;
  }

  clear() {
    this.songs      = [];
    this.currentIdx = 0;
    this.isPlaying  = false;
  }

  elapsed() {
    if (!this.startedAt) return 0;
    return Math.floor((Date.now() - this.startedAt - this.totalPaused) / 1000);
  }
}

const queues = new Map();
function getQueue(guildId) {
  if (!queues.has(guildId)) queues.set(guildId, new MusicQueue(guildId));
  return queues.get(guildId);
}

const pendingSearch = new Map();
const PENDING_SEARCH_TTL = 5 * 60 * 1000; // 5 นาที

function setPendingSearch(guildId, data) {
  // clear timer เก่าของ guild นี้ก่อน (ถ้ามี)
  const old = pendingSearch.get(guildId);
  if (old?._timer) clearTimeout(old._timer);

  const entry = { ...data, _expiresAt: Date.now() + PENDING_SEARCH_TTL };
  entry._timer = setTimeout(() => {
    const cur = pendingSearch.get(guildId);
    if (cur && cur._expiresAt === entry._expiresAt) {
      cur._timer = null;
      pendingSearch.delete(guildId);
    }
  }, PENDING_SEARCH_TTL);
  pendingSearch.set(guildId, entry);
  return entry;
}

function clearPendingSearch(guildId) {
  const cur = pendingSearch.get(guildId);
  if (cur?._timer) clearTimeout(cur._timer);
  pendingSearch.delete(guildId);
}

function sep(spacing = 1, divider = true) {
  return { type: 14, divider, spacing };
}

function text(content) {
  return { type: 10, content: String(content).slice(0, 4000) };
}

function section(content, thumbnailUrl, description = "thumbnail") {
  return {
    type: 9,
    components: [{ type: 10, content: String(content).slice(0, 4000) }],
    accessory: {
      type: 11,
      media: { url: thumbnailUrl },
      description: String(description).slice(0, 100),
    },
  };
}

function container(components, accentColor = BLACK) {
  return { type: 17, accent_color: accentColor, components };
}

function buildProgressBar(current, total, length = 20) {
  if (!total || total <= 0) return "▬".repeat(length);
  const ratio = Math.min(1, Math.max(0, current / total));
  const pos   = Math.round(ratio * (length - 1));
  return "▬".repeat(pos) + "⚫" + "▬".repeat(Math.max(0, length - pos - 1));
}

function formatTime(sec) {
  if (!sec || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// กัน [ ] ในชื่อเพลงทำให้ลิงก์ markdown พัง
function safeTitle(t, max = 70) {
  return String(t || "?")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function buildPlayerCard(queue, song) {
  const durationSec = Math.floor((song.durationMs || 0) / 1000);
  const elapsedSec  = Math.min(queue.elapsed(), durationSec);
  const barText     = buildProgressBar(elapsedSec, durationSec, 20);
  const volBar      = buildProgressBar(queue.volume, 100, 18);

  const comps = [];

  // แสดงสถานะ Buffering ถ้ากำลัง buffer
  const statusEmoji = queue.isBuffering ? "⏳" : "🎵";
  const statusText  = queue.isBuffering ? "BUFFERING" : "NOW PLAYING";

  const headerContent = [
    `- \`${statusEmoji}\` **${statusText}**`,
    ``,
    `- **${song.title}**`,
    `- **${song.author}**`,
  ].join("\n");

  if (song.thumbnail) {
    comps.push(section(headerContent, song.thumbnail, safeTitle(song.title, 100)));
  } else {
    comps.push(text(headerContent));
  }

  comps.push(sep(1, false));
  comps.push(text(`**${formatTime(elapsedSec)}**  ${barText}  **${formatTime(durationSec)}**`));

  comps.push({
    type: 1,
    components: [
      { type: 2, style: ButtonStyle.Secondary, emoji: "⏮", customId: "music_prev" },
      {
        type    : 2,
        style   : ButtonStyle.Secondary,
        emoji   : queue.isBuffering ? "⏳" : (queue.isPlaying ? "⏸" : "▶"),
        customId: "music_playpause",
      },
      { type: 2, style: ButtonStyle.Secondary, emoji: "⏭", customId: "music_skip" },
    ],
  });

  comps.push({
    type: 1,
    components: [
      { type: 2, style: ButtonStyle.Secondary, emoji: "🔀", customId: "music_shuffle" },
      {
        type    : 2,
        style   : ButtonStyle.Secondary,
        emoji   : queue.loop ? "🔂" : "🔁",
        customId: "music_loop",
      },
      { type: 2, style: ButtonStyle.Secondary, emoji: "⏹", customId: "music_stop" },
    ],
  });

  comps.push(sep(1, false));
  comps.push(text(`🔉  ${volBar}  **${queue.volume}%**`));

  comps.push({
    type: 1,
    components: [
      { type: 2, style: ButtonStyle.Secondary, emoji: "🔉", customId: "music_vol_down" },
      { type: 2, style: ButtonStyle.Secondary, emoji: "🔊", customId: "music_vol_up" },
      {
        type    : 2,
        style   : ButtonStyle.Secondary,
        label   : `${queue.volume}%`,
        customId: "music_vol_label",
        disabled: true,
      },
    ],
  });

  const upNext = queue.upcoming.slice(0, 3);
  if (upNext.length) {
    comps.push(sep());
    comps.push(text(
      `**⏭️ ถัดไป**\n` +
      upNext.map((s, i) => `\`${i + 1}.\` [${safeTitle(s.title, 60)}](${s.url}) — \`${s.duration}\``).join("\n") +
      (queue.upcoming.length > 3 ? `\n-# และอีก ${queue.upcoming.length - 3} เพลง` : "")
    ));
  }

  return container(comps, BLACK);
}

function buildSearchContainer(results, query, page = 0) {
  const totalPages = Math.max(1, Math.ceil(results.length / SEARCH_PAGE_SIZE));
  page = Math.min(Math.max(0, page), totalPages - 1);
  const start = page * SEARCH_PAGE_SIZE;
  const slice = results.slice(start, start + SEARCH_PAGE_SIZE);

  // สร้าง listContent แบบตัดที่ขอบรายการ เพื่อไม่ให้ markdown ของรายการสุดท้ายพัง
  const entries = slice.map((r, i) => {
    const title = safeTitle(r.title, 70);
    const auth  = (r.author || "?").slice(0, 30);
    return `**${start + i + 1}.** [${title}](${r.url})\n　　👤 ${auth} | ⏱️ ${r.duration}`;
  });

  let listContent = "";
  for (let i = 0; i < entries.length; i++) {
    const sep = i === 0 ? "" : "\n\n";
    if ((listContent + sep + entries[i]).length > 3800) {
      listContent += `\n-# _...และอีก ${entries.length - i} รายการ_`;
      break;
    }
    listContent += sep + entries[i];
  }

  const menuOptions = slice.map((r, i) => ({
    label      : `${start + i + 1}. ${(r.title || "Unknown").slice(0, 90)}`,
    description: `${(r.author || "Unknown")} | ${r.duration}`.slice(0, 100),
    value      : String(start + i), // index รวม ใช้กับ pending.results ได้เลย
    emoji      : MENU_EMOJI,
  }));

  const comps = [
    text(`- \`🔍\` **ผลการค้นหา:** ${(query || "").slice(0, 80)}\n- **เลือกเพลงจาก dropdown ด้านล่าง** **(${results.length} ผลลัพธ์)**`),
    sep(),
    text(listContent || "(ไม่มีชื่อเพลง)"),
    sep(),
    {
      type: 1,
      components: [{
        type        : 3,
        custom_id   : "search_select",
        placeholder : "🎵 เลือกเพลงที่ต้องการเล่น...",
        options     : menuOptions,
      }],
    },
  ];

  if (totalPages > 1) {
    comps.push({
      type: 1,
      components: [
        { type: 2, style: ButtonStyle.Secondary, emoji: PREV_EMOJI, customId: "search_prev", disabled: page <= 0 },
        { type: 2, style: ButtonStyle.Secondary, label: `${page + 1} / ${totalPages}`, customId: "search_page_label", disabled: true },
        { type: 2, style: ButtonStyle.Secondary, emoji: NEXT_EMOJI, customId: "search_next", disabled: page >= totalPages - 1 },
      ],
    });
  }

  return container(comps, BLACK);
}

function buildSetupContainer() {
  return container([
    {
      type: 12,
      items: [{ media: { url: "https://media.discordapp.net/attachments/1368314450217537546/1559158656757669948/dedd285b73658d0a741ea4d5be0b634e.gif?ex=6ace0f27&is=6accbda7&hm=18c6bbf673a76be626e095b39dbaa283c229f3d0de6e77748f03165a3692a88f&=" } }],
    },
    sep(1, false),
    text([
      "- `🎵` **VENDETTA SHOP**",
      "- **กดปุ่มด้านล่างเพื่อค้นหาเพลงที่ต้องการ**",
    ].join("\n")),
    sep(),
    {
      type: 1,
      components: [
        {
          type: 2,
          style: ButtonStyle.Secondary,
          label: "ค้นหาเพลง",
          emoji: { id: "1102178967009628242", name: "emoji_2", animated: true },
          customId: "setup_search",
        },
      ],
    },
  ], BLACK);
}

async function getCardChannel(queue) {
  if (LOG_CHANNEL_ID) {
    const ch = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (ch && ch.isTextBased()) return ch;
  }
  return queue.textChannel;
}

function stopProgressUpdater(queue) {
  if (queue._progressTimer) {
    clearInterval(queue._progressTimer);
    queue._progressTimer = null;
  }
}

async function deleteCard(queue) {
  stopProgressUpdater(queue);
  const msg = queue.nowPlayingMsg;
  queue.nowPlayingMsg = null;
  if (msg) await msg.delete().catch(() => {});
}

async function sendOrUpdatePlayerCard(queue, song) {
  const channel = await getCardChannel(queue);
  if (!channel) return;

  queue.startedAt   = Date.now();
  queue.totalPaused = 0;
  queue.pausedAt    = 0;

  const payload = { flags: FLAGS.V2, components: [buildPlayerCard(queue, song)] };

  try {
    if (queue.nowPlayingMsg) {
      await queue.nowPlayingMsg.edit(payload);
    } else {
      queue.nowPlayingMsg = await channel.send(payload);
    }
  } catch (e) {
    console.error("❌ Player card error:", e.message);
    // ลบข้อความเก่าที่พัง แล้วส่งใหม่
    try { await queue.nowPlayingMsg?.delete?.(); } catch {}
    queue.nowPlayingMsg = null;
    try { queue.nowPlayingMsg = await channel.send(payload); } catch {}
  }
}

function refreshCard(queue) {
  if (queue.nowPlayingMsg && queue.current) {
    queue.nowPlayingMsg.edit({
      flags: FLAGS.V2,
      components: [buildPlayerCard(queue, queue.current)],
    }).catch(() => {});
  }
}

function startProgressUpdater(queue) {
  stopProgressUpdater(queue);
  queue._progressTimer = setInterval(async () => {
    if (!queue.isPlaying || !queue.current || !queue.nowPlayingMsg) return;
    try {
      await queue.nowPlayingMsg.edit({
        flags: FLAGS.V2,
        components: [buildPlayerCard(queue, queue.current)],
      });
    } catch {
      stopProgressUpdater(queue);
      queue.nowPlayingMsg = null;
    }
  }, 5000);
}

function getYtdlpInfo(url) {
  return new Promise((resolve) => {
    if (!YTDLP_CMD) return resolve(null);
    const proc = spawn(YTDLP_CMD, ["-J", "--no-playlist", "--no-warnings", url], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!proc.stdout) return resolve(null);
    let data = "";
    let done = false;
    const timer = setTimeout(() => finish(null), 20_000);
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { proc.kill(); } catch {}
      resolve(val);
    };
    proc.stdout.on("data", (c) => (data += c));
    proc.on("close", (code) => {
      if (code !== 0) return finish(null);
      try { finish(JSON.parse(data)); } catch { finish(null); }
    });
    proc.on("error", () => finish(null));
  });
}

async function searchTracks(query, requester) {
  const isUrl = /^https?:\/\//i.test(query);
  try {
    if (isUrl) {
      const meta = await getYtdlpInfo(query);
      if (!meta) return { type: "search", tracks: [] };
      return {
        type: "track",
        tracks: [{
          title     : meta.title,
          author    : meta.uploader || "Unknown",
          duration  : formatTime(meta.duration || 0),
          durationMs: (meta.duration || 0) * 1000,
          url       : meta.webpage_url || query,
          videoId   : meta.id,
          thumbnail : meta.thumbnail,
          requester,
        }],
      };
    }

    const result = await yts(query);
    const videos = result.videos.slice(0, 30);
    if (!videos.length) return { type: "search", tracks: [] };

    return {
      type: "search",
      tracks: videos.map((v) => ({
        title     : v.title,
        author    : v.author?.name || "Unknown",
        duration  : formatTime(v.seconds || 0),
        durationMs: (v.seconds || 0) * 1000,
        url       : v.url,
        videoId   : v.videoId,
        thumbnail : v.thumbnail || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
        requester,
      })),
    };
  } catch (e) {
    console.error("❌ Search error:", e.message);
    return { type: "search", tracks: [] };
  }
}

function createYtdlpStream(url) {
  if (!YTDLP_CMD || !FFMPEG_CMD) throw new Error("yt-dlp หรือ ffmpeg ไม่พร้อมใช้งาน");

  const ytdlp = spawn(YTDLP_CMD, [
    "-f", "bestaudio", "-o", "-",
    "--no-playlist", "--quiet", "--no-warnings", url,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const ffmpeg = spawn(FFMPEG_CMD, [
    "-i", "pipe:0", "-analyzeduration", "0", "-loglevel", "0",
    "-acodec", "libopus", "-f", "ogg", "-ar", "48000", "-ac", "2", "pipe:1",
  ], { stdio: ["pipe", "pipe", "pipe"] });

  if (!ytdlp.stdout || !ffmpeg.stdin || !ffmpeg.stdout) {
    try { ytdlp.kill(); } catch {}
    try { ffmpeg.kill(); } catch {}
    throw new Error("spawn fail: stdio null");
  }

  ytdlp.stdout.pipe(ffmpeg.stdin);
  ytdlp.on("error", (e) => console.error("❌ yt-dlp error:", e.message));
  ffmpeg.on("error", (e) => console.error("❌ ffmpeg error:", e.message));

  // timeout 60s กัน yt-dlp ค้าง (เช่น YouTube challenge) — ประกาศก่อน cleanup
  let stallTimer = null;

  // cleanup แบบ idempotent: เรียกซ้ำได้ไม่ error
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
    try { ytdlp.kill(); } catch {}
    try { ffmpeg.kill(); } catch {}
  };
  ytdlp.on("close", () => { try { ffmpeg.stdin.end(); } catch {} });
  ffmpeg.on("close", cleanup);
  ffmpeg.stdout.on("close", cleanup);
  ffmpeg.stdout.on("error", cleanup);

  stallTimer = setTimeout(() => {
    console.error("❌ Stream stall: yt-dlp ไม่ส่งข้อมูลภายใน 60s — kill");
    cleanup();
    try { ffmpeg.stdout.destroy(); } catch {}
  }, 60_000);

  return ffmpeg.stdout;
}

async function playSong(guildId, song) {
  const queue = getQueue(guildId);
  if (!queue.player || !queue.connection) return;

  try {
    const stream = createYtdlpStream(song.url);
    const resource = createAudioResource(stream, {
      inputType: StreamType.OggOpus,
      inlineVolume: true,
    });
    resource.volume?.setVolume(queue.volume / 100);

    // cleanup resource เก่าก่อนแทน (player.stop() ไม่ destroy resource)
    const oldResource = queue.resource;
    queue.resource = resource;
    queue.player.play(resource);
    queue.isPlaying = true;
    if (oldResource) {
      try { oldResource.playStream?.destroy?.(); } catch {}
    }

    await sendOrUpdatePlayerCard(queue, song);
    startProgressUpdater(queue);
    queue._retried = false;

    // คืนค่า loop หลังจาก music_prev เล่นเพลงที่ต้องการแล้ว
    if (queue._restoreLoopAfter) {
      queue.loop = queue._restoreLoopAfter;
      queue._restoreLoopAfter = null;
    }
  } catch (err) {
    console.error("❌ playSong error:", err.message);
    if (queue.textChannel) {
      queue.textChannel.send({
        flags: FLAGS.V2,
        components: [container([
          text(`❌ **เล่นเพลงไม่ได้**\n🎵 **${song.title}**\n-# \`${err.message.slice(0, 200)}\``),
        ], BLACK)],
      }).catch(() => {});
    }

    // reset state ของ music_prev ที่ค้างเสมอ
    queue._restoreLoopAfter = null;

    // เพลงนี้ fail — ปิด loop ทั้งสองแบบก่อน เพื่อให้ next() advance ตามปกติ
    queue.loop = false;
    queue.loopQueue = false;

    // เก็บ index ปัจจุบันไว้ก่อน — เพราะ queue.next() จะแก้ currentIdx
    const failedIdx = queue.currentIdx;

    const next = queue.next();
    if (next && next !== song) {
      // มีเพลงถัดไปจริง ๆ → เล่นต่อ
      playSong(guildId, next);
    } else if (!queue._retried && queue.songs[failedIdx] === song) {
      // เพลงเดียว (หรือเพลงสุดท้าย) และยังไม่เคย retry → retry ครั้งเดียว
      queue._retried = true;
      queue.currentIdx = failedIdx; // กลับไปชี้เพลงเดิม
      setTimeout(() => playSong(guildId, song), 2000);
    } else {
      // retry แล้วยัง fail หรือไม่มีเพลงอื่น → ปิด
      queue._retried = false;
      queue.isPlaying = false;
      deleteCard(queue);
      try { queue.connection?.destroy(); } catch {}
      queues.delete(guildId);
    }
  }
}

function attachPlayerEvents(guildId, player, connection) {
  const queue = getQueue(guildId);
  queue.player     = player;
  queue.connection = connection;

  player.on(AudioPlayerStatus.Playing, () => {
    queue.isPlaying = true;
    queue.isBuffering = false;
    if (queue._destroyTimer) {
      clearTimeout(queue._destroyTimer);
      queue._destroyTimer = null;
    }
    if (queue.pausedAt) {
      queue.totalPaused += Date.now() - queue.pausedAt;
      queue.pausedAt = 0;
    }
  });

  player.on(AudioPlayerStatus.Paused, () => {
    queue.pausedAt = Date.now();
    queue.isPlaying = false;
  });

  player.on(AudioPlayerStatus.AutoPaused, () => {
    queue.pausedAt = Date.now();
    queue.isPlaying = false;
  });

  player.on(AudioPlayerStatus.Buffering, () => {
    queue.isBuffering = true;
    refreshCard(queue);
  });

  player.on(AudioPlayerStatus.Idle, () => {
    if (queue.stopped) return;

    const next = queue.next();
    if (next) {
      playSong(guildId, next);
    } else {
      queue.isPlaying = false;
      deleteCard(queue);

      queue._destroyTimer = setTimeout(() => {
        try { connection.destroy(); } catch {}
        queues.delete(guildId);
      }, 30_000);
    }
  });

  player.on("error", (err) => {
    console.error("❌ Player error:", err.message);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      await deleteCard(queue);
      try { connection.destroy(); } catch {}
      queue.clear();
      queues.delete(guildId);
    }
  });

  connection.on(VoiceConnectionStatus.Destroyed, async () => {
    stopProgressUpdater(queue);
    if (queue._destroyTimer) {
      clearTimeout(queue._destroyTimer);
      queue._destroyTimer = null;
    }
    // ลบการ์ดเพลงก่อน reset pointer (deleteCard อ่าน nowPlayingMsg แล้วตั้งเป็น null)
    await deleteCard(queue);
    queue.player     = null;
    queue.connection = null;
    queue.resource   = null;
    queue.isPlaying  = false;
    queue.clear();
    queues.delete(guildId);
  });

  connection.subscribe(player);
}

const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("🎵 สร้างห้อง Music และส่งแผงควบคุมเพลง"),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log("✅  Slash commands ลงทะเบียนแล้ว");
}

async function joinVoiceFromInteraction(interaction, targetChannel = null) {
  const voiceChannel = targetChannel || interaction.member?.voice?.channel;
  if (!voiceChannel) return null;

  const queue = getQueue(interaction.guildId);
  queue.stopped = false;

  if (!queue.connection) {
    try {
      const connection = joinVoiceChannel({
        channelId     : voiceChannel.id,
        guildId       : interaction.guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf      : false,
        selfMute      : false,
      });

      const player = createAudioPlayer();
      attachPlayerEvents(interaction.guildId, player, connection);
    } catch (e) {
      console.error("❌ joinVoiceChannel error:", e.message);
      return null;
    }
  }

  queue.textChannel = interaction.channel;
  return queue;
}

function buildModal(customId, title, label, placeholder) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);
  const input = new TextInputBuilder()
    .setCustomId("input")
    .setLabel(label)
    .setPlaceholder(placeholder)
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

async function handleSetup(interaction) {
  const guild = interaction.guild;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    let category = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name === MUSIC_CONFIG.CATEGORY_NAME
    );
    if (!category) {
      category = await guild.channels.create({
        name: MUSIC_CONFIG.CATEGORY_NAME,
        type: ChannelType.GuildCategory,
      });
    }

    let voiceChannel = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildVoice && c.name === MUSIC_CONFIG.VOICE_CHANNEL_NAME
    );
    if (!voiceChannel) {
      voiceChannel = await guild.channels.create({
        name: MUSIC_CONFIG.VOICE_CHANNEL_NAME,
        type: ChannelType.GuildVoice,
        parent: category.id,
      });
    }

    let textChannel = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && c.name === MUSIC_CONFIG.TEXT_CHANNEL_NAME
    );
    if (!textChannel) {
      textChannel = await guild.channels.create({
        name: MUSIC_CONFIG.TEXT_CHANNEL_NAME,
        type: ChannelType.GuildText,
        parent: category.id,
      });
    }

    await textChannel.send({
      flags: FLAGS.V2,
      components: [buildSetupContainer()],
    });

    const logLine = LOG_CHANNEL_ID
      ? `\n🎵 **ห้องการ์ดเพลง:** <#${LOG_CHANNEL_ID}>`
      : "\n⚠️ ยังไม่ได้ตั้ง LOG_CHANNEL_ID (การ์ดจะส่งในห้องคำสั่ง)";

    await interaction.editReply({
      content: `✅ สร้างห้องสำเร็จ!\n📢 **ห้องเสียง:** <#${voiceChannel.id}>\n💬 **ห้องคำสั่ง:** <#${textChannel.id}>${logLine}`,
    });

    setTimeout(() => {
      interaction.deleteReply().catch(() => {});
    }, 5000);

  } catch (e) {
    console.error("❌ handleSetup error:", e);
    await interaction.editReply({ content: `❌ เกิดข้อผิดพลาด: ${e.message}` });
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  const guildId = interaction.guildId;
  if (!guildId) return; 

  if (interaction.isChatInputCommand() && interaction.commandName === "setup") {
    return handleSetup(interaction);
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "search_select") {
    const pending = pendingSearch.get(guildId);
    if (!pending) {
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        components: [container([text("- \`❌\` **หมดเวลาเลือกเพลง — ค้นหาใหม่**")], BLACK)],
      });
    }

    const idx  = parseInt(interaction.values[0], 10);
    const song = pending.results[idx];
    if (!song) {
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        components: [container([text("- \`❌\` **ไม่พบเพลงที่เลือก**")], BLACK)],
      });
    }

    clearPendingSearch(guildId);

    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        components: [container([text("- \`❌\` **คุณต้องอยู่ใน Voice Channel ก่อน!**")], BLACK)],
      });
    }

    await interaction.deferUpdate();

    const queue = await joinVoiceFromInteraction(interaction);
    if (!queue) {
      return interaction.editReply({
        components: [container([text("- \`❌\` **ไม่สามารถเข้าห้อง Voice ได้**")], BLACK)],
      });
    }

    song.requester = interaction.user.id;
    queue.add(song);

    if (!queue.isPlaying) {
      queue.currentIdx = queue.songs.length - 1;
      await playSong(guildId, song);
      await interaction.editReply({
        components: [container([text(`- \`✅\` **เริ่มเล่น** **${song.title}**`)], BLACK)],
      });
    } else {
      refreshCard(queue);
      await interaction.editReply({
        components: [container([text(`- \`✅\` **เพิ่มเข้าคิว:** **${song.title}**`)], BLACK)],
      });
    }
    return;
  }

  // ─── ปุ่ม ───
  if (interaction.isButton()) {
    const queue = getQueue(guildId);
    const { customId } = interaction;

    if (customId === "setup_search") {
      return interaction.showModal(
        buildModal("setup_search", "🔍 ค้นหาเพลง", "ชื่อเพลงที่ต้องการ", "เช่น pun")
      );
    }

    // ─── เปลี่ยนหน้าผลการค้นหา ───
    if (customId === "search_prev" || customId === "search_next") {
      const pending = pendingSearch.get(guildId);
      if (!pending) {
        return interaction.reply({
          flags: MessageFlags.Ephemeral,
          components: [container([text("- `❌` **หมดเวลาเลือกเพลง — ค้นหาใหม่**")], BLACK)],
        });
      }
      const totalPages = Math.max(1, Math.ceil(pending.results.length / SEARCH_PAGE_SIZE));
      pending.page = Math.min(totalPages - 1, Math.max(0, pending.page + (customId === "search_next" ? 1 : -1)));
      return interaction.update({
        components: [buildSearchContainer(pending.results, pending.query, pending.page)],
      });
    }

    if (!queue.player) {
      return interaction.reply({ content: "- \`❌\` **ไม่มีเพลงเล่นอยู่**", flags: MessageFlags.Ephemeral });
    }

    if (customId === "music_playpause") {
      const status = queue.player.state.status;
      if (status === AudioPlayerStatus.Paused) {
        queue.player.unpause();
        // isPlaying จะถูก sync ใน Playing event
      } else if (status === AudioPlayerStatus.Playing || status === AudioPlayerStatus.Buffering) {
        queue.player.pause();
        // isPlaying จะถูก sync ใน Paused event
      } else {
        // Idle — ไม่ทำอะไรเพราะเพลงจบไปแล้ว
        return interaction.reply({
          content: "- \`❌\` **ไม่มีเพลงกำลังเล่นอยู่**",
          flags: MessageFlags.Ephemeral,
        });
      }
      return interaction.reply({
        content: status === AudioPlayerStatus.Paused ? "▶️ เล่นต่อ" : "⏸️ พักแล้ว",
        flags: MessageFlags.Ephemeral,
      });
    }

    if (customId === "music_skip") {
      queue.player.stop();
      return interaction.reply({ content: "⏭️ ข้ามแล้ว!", flags: MessageFlags.Ephemeral });
    }

    if (customId === "music_prev") {
      if (queue.currentIdx <= 0) {
        return interaction.reply({ content: "- \`❌\` **ไม่มีเพลงก่อนหน้า**", flags: MessageFlags.Ephemeral });
      }
      // ปิด loop ชั่วคราวเพื่อให้ย้อนกลับได้ แล้วค่อยเปิดคืนหลังเล่นเพลงนั้น
      queue._restoreLoopAfter = queue.loop;
      queue.loop = false;
      queue.currentIdx -= 2;
      queue.player.stop();
      return interaction.reply({ content: "- \`⏮️\` **เพลงก่อนหน้า!**", flags: MessageFlags.Ephemeral });
    }

    if (customId === "music_shuffle") {
      if (queue.songs.length <= 1) {
        return interaction.reply({ content: "- \`❌\` **มีเพลงไม่พอสุ่ม**", flags: MessageFlags.Ephemeral });
      }
      queue.shuffle();
      refreshCard(queue);
      return interaction.reply({ content: "- \`🔀\` **สุ่มคิวแล้ว!**", flags: MessageFlags.Ephemeral });
    }

    if (customId === "music_loop") {
      let mode = "";
      if (!queue.loop && !queue.loopQueue) {
        queue.loop = true;
        mode = "🔂 ลูปเพลงนี้";
      } else if (queue.loop) {
        queue.loop = false;
        queue.loopQueue = true;
        mode = "🔁 ลูปทั้งคิว";
      } else {
        queue.loopQueue = false;
        mode = "➡️ ปิดลูป";
      }
      refreshCard(queue);
      return interaction.reply({ content: mode, flags: MessageFlags.Ephemeral });
    }

    if (customId === "music_vol_up") {
      queue.volume = Math.min(100, queue.volume + 10);
      queue.resource?.volume?.setVolume(queue.volume / 100);
      refreshCard(queue);
      return interaction.reply({ content: `- \`🔊\` **${queue.volume}** **%**`, flags: MessageFlags.Ephemeral });
    }

    if (customId === "music_vol_down") {
      queue.volume = Math.max(0, queue.volume - 10);
      queue.resource?.volume?.setVolume(queue.volume / 100);
      refreshCard(queue);
      return interaction.reply({ content: `- \`🔉\` **${queue.volume}** **%**`, flags: MessageFlags.Ephemeral });
    }

    if (customId === "music_stop") {
      queue.stopped = true;
      stopProgressUpdater(queue);
      if (queue._destroyTimer) clearTimeout(queue._destroyTimer);
      await deleteCard(queue);

      queue.clear();
      try { queue.player?.stop(); } catch {}
      try { queue.connection?.destroy(); } catch {}
      queues.delete(guildId);

      return interaction.reply({ content: "- \`🛑\` **หยุดเล่นแล้ว!**", flags: MessageFlags.Ephemeral });
    }

    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === "setup_search") {
    const inputVal     = interaction.fields.getTextInputValue("input").trim();
    const voiceChannel = interaction.member?.voice?.channel;

    if (!voiceChannel) {
      return interaction.reply({
        content: "- \`❌\` **คุณต้องอยู่ใน Voice Channel ก่อน!**",
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.reply({
      flags: FLAGS.V2_EPHEMERAL,
      components: [container([text("- \`🔍\` **กำลังค้นหา...**")], BLACK)],
    });

    try {
      const res = await searchTracks(inputVal, interaction.user.id);

      if (!res.tracks.length) {
        return interaction.editReply({
          components: [container([text("- \`❌\` **ไม่พบผลการค้นหา**")], BLACK)],
        });
      }

      if (res.type === "track") {
        const song  = res.tracks[0];
        const queue = await joinVoiceFromInteraction(interaction);
        if (!queue) {
          return interaction.editReply({
            components: [container([text("- \`❌\` **ไม่สามารถเข้าห้อง Voice ได้**")], BLACK)],
          });
        }
        queue.add(song);
        if (!queue.isPlaying) {
          queue.currentIdx = queue.songs.length - 1;
          await playSong(guildId, song);
          return interaction.editReply({
            components: [container([text(`- \`✅\` **เริ่มเล่น** **${song.title}**`)], BLACK)],
          });
        }
        refreshCard(queue);
        return interaction.editReply({
          components: [container([text(`- \`✅\` **เพิ่มเข้าคิว:** **${song.title}**`)], BLACK)],
        });
      }

      setPendingSearch(guildId, { results: res.tracks, voiceChannel, query: inputVal, page: 0 });
      await interaction.editReply({
        components: [buildSearchContainer(res.tracks, inputVal, 0)],
      });
    } catch (e) {
      console.error("❌ Modal submit error:", e);
      await interaction.editReply({
        components: [container([text(`- \`❌\` ${e.message}`)], BLACK)],
      });
    }
    return;
  }
});

process.on("unhandledRejection", (r) => console.error("UnhandledRejection:", r));
process.on("uncaughtException",  (e) => console.error("UncaughtException:",  e));

process.on("SIGINT", async () => {
  console.log("\n👋 กำลังปิดบอท...");
  for (const q of queues.values()) {
    q.stopped = true;
    await deleteCard(q);
    try { q.player?.stop(); } catch {}
    try { q.connection?.destroy(); } catch {}
  }
  process.exit(0);
});

client.once(Events.ClientReady, async (c) => {
  console.log(`\n🎵  ${c.user.tag} พร้อมใช้งานแล้ว!`);
  await registerCommands();
});

client.login(TOKEN);
