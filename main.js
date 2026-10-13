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
  PermissionFlagsBits,
  ActivityType,
} = require("discord.js");

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  entersState,
  generateDependencyReport,
} = require("@discordjs/voice");

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const yts = require("yt-search");

const TOKEN          = process.env.DISCORD_TOKEN;
const CLIENT_ID      = process.env.CLIENT_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error("❌  กรุณาตั้งค่า DISCORD_TOKEN และ CLIENT_ID ใน .env / Railway Variables");
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

const SEARCH_PAGE_SIZE   = 10;
const PENDING_SEARCH_TTL = 5 * 60 * 1000;
const STARTUP_TIMEOUT    = 60_000; 
const VOICE_READY_TIMEOUT = 20_000;

const MENU_EMOJI = { id: "1457664481466257479", name: "prettyarrowr", animated: true };
const PREV_EMOJI = { id: "1457663782376575016", name: "arrow", animated: true };
const NEXT_EMOJI = { id: "1457663782376575016", name: "arrow", animated: true };

// ───────────────────────── Binaries ─────────────────────────

function findBinary(name) {
  const exeSuffix = IS_WINDOWS ? ".exe" : "";
  const localCandidates = [
    path.join(__dirname, `${name}${exeSuffix}`),
    path.join(__dirname, "bin", `${name}${exeSuffix}`),
    path.join(process.cwd(), `${name}${exeSuffix}`),
    path.join(process.cwd(), "bin", `${name}${exeSuffix}`),
  ];
  for (const c of localCandidates) {
    if (fs.existsSync(c)) return c;
  }
  const checkCmd = IS_WINDOWS ? "where" : "which";
  const result = spawnSync(checkCmd, [name], { stdio: ["ignore", "pipe", "ignore"] });
  if (result.status === 0) return name;
  return null;
}

const YTDLP_CMD  = findBinary("yt-dlp");
const FFMPEG_CMD = findBinary("ffmpeg");

console.log(`\n🔍 yt-dlp : ${YTDLP_CMD || "❌ ไม่พบ"}`);
console.log(`🔍 ffmpeg : ${FFMPEG_CMD || "❌ ไม่พบ"}`);

if (YTDLP_CMD) {
  const v = spawnSync(YTDLP_CMD, ["--version"], { encoding: "utf8" });
  console.log(`🔍 yt-dlp version : ${(v.stdout || "").trim() || "?"}`);
}

console.log("\n" + generateDependencyReport() + "\n");
function resolveCookiesPath() {
  try {
    const dest = path.join(os.tmpdir(), "yt-cookies.txt");
    if (process.env.YTDLP_COOKIES_B64) {
      fs.writeFileSync(dest, Buffer.from(process.env.YTDLP_COOKIES_B64, "base64"));
      return dest;
    }
    const src = process.env.YTDLP_COOKIES_FILE || path.join(__dirname, "cookies.txt");
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      return dest;
    }
  } catch (e) {
    console.error("❌ จัดการ cookies ไม่ได้:", e.message);
  }
  return null;
}

const COOKIES_PATH = resolveCookiesPath();
console.log(`🍪 cookies : ${COOKIES_PATH ? "ใช้งาน" : "ไม่มี"}`);

function ytdlpBaseArgs() {
  const args = ["--no-playlist", "--no-cache-dir", "--no-progress"];
  if (!process.env.YTDLP_NO_JS_RUNTIME) args.push("--js-runtimes", "node");
  if (COOKIES_PATH) args.push("--cookies", COOKIES_PATH);
  if (process.env.YTDLP_PROXY) args.push("--proxy", process.env.YTDLP_PROXY);
  if (process.env.YTDLP_EXTRA_ARGS) args.push(...process.env.YTDLP_EXTRA_ARGS.split(/\s+/).filter(Boolean));
  return args;
}

try {
  const { DefaultWebSocketManagerOptions } = require("@discordjs/ws");
  DefaultWebSocketManagerOptions.identifyProperties.browser = "Discord iOS";
  DefaultWebSocketManagerOptions.identifyProperties.os      = "iOS";
  DefaultWebSocketManagerOptions.identifyProperties.device  = "iOS";
} catch (e) {
  console.warn("⚠️ ตั้งค่า identifyProperties ไม่สำเร็จ:", e.message);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
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
    this.isBuffering    = false;
    this.stopped        = false;
    this.player         = null;
    this.connection     = null;
    this.ready          = null;
    this.resource       = null;
    this.textChannel    = null;
    this.nowPlayingMsg  = null;
    this.startedAt      = 0;
    this.pausedAt       = 0;
    this.totalPaused    = 0;

    this._destroyTimer  = null;
    this._progressTimer = null;
    this._cleanupStream = null;
    this._streamSeq     = 0;
    this._pendingError  = null;
    this._jumping       = false;
    this._forceNext     = false;
    this._retried       = false;
    this._trackStart    = false;
    this._restoreLoop   = null;
  }

  add(song)      { this.songs.push(song); }
  get current()  { return this.songs[this.currentIdx] || null; }
  get upcoming() { return this.songs.slice(this.currentIdx + 1); }

  next(force = false) {
    if (this.loop && !force) return this.songs[this.currentIdx] || null;
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
    const paused = this.totalPaused + (this.pausedAt ? Date.now() - this.pausedAt : 0);
    return Math.max(0, Math.floor((Date.now() - this.startedAt - paused) / 1000));
  }

  killStream() {
    const c = this._cleanupStream;
    this._cleanupStream = null;
    if (c) { try { c(); } catch {} }
  }
}

const queues = new Map();
function getQueue(guildId) {
  if (!queues.has(guildId)) queues.set(guildId, new MusicQueue(guildId));
  return queues.get(guildId);
}

const pendingSearch = new Map();
const pKey = (guildId, userId) => `${guildId}:${userId}`;

function setPendingSearch(key, data) {
  const old = pendingSearch.get(key);
  if (old?._timer) clearTimeout(old._timer);
  const entry = { ...data, _expiresAt: Date.now() + PENDING_SEARCH_TTL };
  entry._timer = setTimeout(() => {
    const cur = pendingSearch.get(key);
    if (cur && cur._expiresAt === entry._expiresAt) pendingSearch.delete(key);
  }, PENDING_SEARCH_TTL);
  pendingSearch.set(key, entry);
  return entry;
}

function clearPendingSearch(key) {
  const cur = pendingSearch.get(key);
  if (cur?._timer) clearTimeout(cur._timer);
  pendingSearch.delete(key);
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

function emo(e) {
  return typeof e === "string" ? { name: e } : e;
}

function btn(customId, emoji, extra = {}) {
  return { type: 2, style: ButtonStyle.Secondary, custom_id: customId, emoji: emo(emoji), ...extra };
}

const msgCard   = (msg) => container([text(msg)], BLACK);
const replyEph  = (msg) => ({ flags: FLAGS.V2_EPHEMERAL, components: [msgCard(msg)] });
const editCard  = (msg) => ({ flags: FLAGS.V2, components: [msgCard(msg)] });

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
  const elapsedSec  = durationSec ? Math.min(queue.elapsed(), durationSec) : queue.elapsed();
  const barText     = buildProgressBar(elapsedSec, durationSec, 20);
  const volBar      = buildProgressBar(queue.volume, 100, 18);

  const comps = [];

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
      btn("music_prev", "⏮"),
      btn("music_playpause", queue.isBuffering ? "⏳" : (queue.isPlaying ? "⏸" : "▶")),
      btn("music_skip", "⏭"),
    ],
  });

  comps.push({
    type: 1,
    components: [
      btn("music_shuffle", "🔀"),
      btn("music_loop", queue.loop ? "🔂" : "🔁"),
      btn("music_stop", "⏹"),
    ],
  });

  comps.push(sep(1, false));
  comps.push(text(`🔉  ${volBar}  **${queue.volume}%**`));

  comps.push({
    type: 1,
    components: [
      btn("music_vol_down", "🔉"),
      btn("music_vol_up", "🔊"),
      { type: 2, style: ButtonStyle.Secondary, label: `${queue.volume}%`, custom_id: "music_vol_label", disabled: true },
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

  const entries = slice.map((r, i) => {
    const title = safeTitle(r.title, 70);
    const auth  = (r.author || "?").slice(0, 30);
    return `**${start + i + 1}.** [${title}](${r.url})\n　　👤 ${auth} | ⏱️ ${r.duration}`;
  });

  let listContent = "";
  for (let i = 0; i < entries.length; i++) {
    const gap = i === 0 ? "" : "\n\n";
    if ((listContent + gap + entries[i]).length > 3800) {
      listContent += `\n-# _...และอีก ${entries.length - i} รายการ_`;
      break;
    }
    listContent += gap + entries[i];
  }

  const menuOptions = slice.map((r, i) => ({
    label      : `${start + i + 1}. ${(r.title || "Unknown").slice(0, 90)}`,
    description: `${(r.author || "Unknown")} | ${r.duration}`.slice(0, 100),
    value      : String(start + i),
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
        type       : 3,
        custom_id  : "search_select",
        placeholder: "🎵 เลือกเพลงที่ต้องการเล่น...",
        options    : menuOptions,
      }],
    },
  ];

  if (totalPages > 1) {
    comps.push({
      type: 1,
      components: [
        btn("search_prev", PREV_EMOJI, { disabled: page <= 0 }),
        { type: 2, style: ButtonStyle.Secondary, label: `${page + 1} / ${totalPages}`, custom_id: "search_page_label", disabled: true },
        btn("search_next", NEXT_EMOJI, { disabled: page >= totalPages - 1 }),
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
      components: [{
        type: 2,
        style: ButtonStyle.Secondary,
        label: "ค้นหาเพลง",
        emoji: { id: "1102178967009628242", name: "emoji_2", animated: true },
        custom_id: "setup_search",
      }],
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

  const payload = { flags: FLAGS.V2, components: [buildPlayerCard(queue, song)] };

  try {
    if (queue.nowPlayingMsg) {
      await queue.nowPlayingMsg.edit(payload);
    } else {
      queue.nowPlayingMsg = await channel.send(payload);
    }
  } catch (e) {
    console.error("❌ Player card error:", e.message);
    try { await queue.nowPlayingMsg?.delete?.(); } catch {}
    queue.nowPlayingMsg = null;
    try { queue.nowPlayingMsg = await channel.send(payload); } catch (e2) {
      console.error("❌ ส่งการ์ดไม่ได้ (เช็คสิทธิ์บอทในห้อง):", e2.message);
    }
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
    const proc = spawn(YTDLP_CMD, ["-J", ...ytdlpBaseArgs(), url], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let data = "";
    let errBuf = "";
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { proc.kill(); } catch {}
      resolve(val);
    };
    const timer = setTimeout(() => {
      console.error("[yt-dlp] getInfo timeout 30s");
      finish(null);
    }, 30_000);
    proc.stdout.on("data", (c) => (data += c));
    proc.stderr.on("data", (c) => (errBuf += c));
    proc.on("close", (code) => {
      if (code !== 0) {
        console.error("[yt-dlp] getInfo failed:", errBuf.trim().slice(-500));
        return finish(null);
      }
      try { finish(JSON.parse(data)); } catch { finish(null); }
    });
    proc.on("error", (e) => { console.error("[yt-dlp] spawn error:", e.message); finish(null); });
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

    const pick = (r) => (r?.videos || []).filter((v) => v.seconds > 0);
    let videos = pick(await yts({ query, hl: "th", gl: "TH", category: "music" }).catch(() => null));
    if (!videos.length) videos = pick(await yts({ query, hl: "th", gl: "TH" }));
    videos = videos.slice(0, 30);
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

function createYtdlpStream(url, onFail) {
  if (!YTDLP_CMD || !FFMPEG_CMD) throw new Error("yt-dlp หรือ ffmpeg ไม่พร้อมใช้งาน");

  const ytdlp = spawn(YTDLP_CMD, [
    ...ytdlpBaseArgs(),
    "-f", "bestaudio/best", "-o", "-",
    "--retries", "3", "--fragment-retries", "3",
    url,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const ffmpeg = spawn(FFMPEG_CMD, [
    "-hide_banner", "-loglevel", "error",
    "-analyzeduration", "0",
    "-i", "pipe:0",
    "-vn", "-f", "s16le", "-ar", "48000", "-ac", "2",
    "pipe:1",
  ], { stdio: ["pipe", "pipe", "pipe"] });

  if (!ytdlp.stdout || !ytdlp.stderr || !ffmpeg.stdin || !ffmpeg.stdout || !ffmpeg.stderr) {
    try { ytdlp.kill(); } catch {}
    try { ffmpeg.kill(); } catch {}
    throw new Error("spawn fail: stdio null");
  }

  let errTail = "";
  let bytes   = 0;
  let cleaned = false;
  let startupTimer = null;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (startupTimer) clearTimeout(startupTimer);
    startupTimer = null;
    try { ytdlp.kill("SIGKILL"); } catch {}
    try { ffmpeg.kill("SIGKILL"); } catch {}
  };

  const fail = (err) => {
    if (cleaned) return;
    console.error("❌ Stream fail:", err.message);
    try { onFail(err); } catch {}
    try { ffmpeg.stdout.destroy(err); } catch {}
    cleanup();
  };

  ytdlp.stdout.on("error", () => {});
  ffmpeg.stdin.on("error", () => {});
  ytdlp.on("error", (e) => fail(new Error(`yt-dlp spawn error: ${e.message}`)));
  ffmpeg.on("error", (e) => fail(new Error(`ffmpeg spawn error: ${e.message}`)));

  ytdlp.stderr.on("data", (d) => {
    const s = d.toString();
    errTail = (errTail + s).slice(-1000);
    console.error("[yt-dlp]", s.trim());
  });
  ffmpeg.stderr.on("data", (d) => console.error("[ffmpeg]", d.toString().trim()));

  ytdlp.stdout.pipe(ffmpeg.stdin);

  startupTimer = setTimeout(() => fail(new Error("หมดเวลารอข้อมูลเสียงจาก yt-dlp (60s)")), STARTUP_TIMEOUT);
  ytdlp.stdout.on("data", (c) => {
    bytes += c.length;
    if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  });

  ytdlp.on("close", (code) => {
    try { ffmpeg.stdin.end(); } catch {}
    if (cleaned) return;
    if (code !== 0) {
      const lines = errTail.trim().split("\n").filter(Boolean);
      const msg = lines.reverse().find((l) => /ERROR/i.test(l)) || lines[0] || `yt-dlp exited with code ${code}`;
      fail(new Error(msg));
    } else if (bytes === 0) {
      fail(new Error("yt-dlp ไม่ส่งข้อมูลเสียงออกมา"));
    }
  });

  ffmpeg.on("close", (code) => {
    if (cleaned) return;
    if (code !== 0 && code !== null) fail(new Error(`ffmpeg exited with code ${code}`));
    else cleanup(); 
  });

  return { stream: ffmpeg.stdout, cleanup };
}

function explainError(msg) {
  const m = String(msg || "");
  if (/Sign in to confirm|not a bot|cookies/i.test(m)) {
    return "YouTube บล็อก IP ของเซิร์ฟเวอร์ → ต้องใส่ cookies (ตั้ง YTDLP_COOKIES_B64) หรืออัปเดต yt-dlp";
  }
  if (/ENOENT/.test(m)) return "ไม่พบโปรแกรม yt-dlp / ffmpeg บนเซิร์ฟเวอร์";
  return m;
}

async function shutdown(guildId, queue = queues.get(guildId)) {
  if (!queue) return;
  queue.stopped = true;
  stopProgressUpdater(queue);
  if (queue._destroyTimer) { clearTimeout(queue._destroyTimer); queue._destroyTimer = null; }
  queue.killStream();
  await deleteCard(queue);
  queue.clear();
  try { queue.player?.stop(true); } catch {}
  try { queue.connection?.destroy(); } catch {}
  if (queues.get(guildId) === queue) queues.delete(guildId);
}

function failTrack(guildId, queue, song, err) {
  if (queues.get(guildId) !== queue || queue.stopped) return;

  const reason = explainError(err?.message);
  console.error(`❌ เล่นไม่ได้: ${song?.title} — ${err?.message}`);

  if (queue._retried && queue.textChannel) {
    queue.textChannel.send({
      flags: FLAGS.V2,
      components: [msgCard(`❌ **เล่นเพลงไม่ได้**\n🎵 **${song?.title ?? "?"}**\n-# \`${reason.slice(0, 300)}\``)],
    }).catch(() => {});
  }

  queue._restoreLoop = null;

  if (!queue._retried) {
    queue._retried = true;
    setTimeout(() => {
      if (queues.get(guildId) === queue && !queue.stopped && queue.current === song &&
          queue.player?.state.status === AudioPlayerStatus.Idle) {
        playSong(guildId, song);
      }
    }, 2000);
    return;
  }

  queue._retried = false;
  const next = queue.next(true);
  if (next && next !== song) {
    playSong(guildId, next);
  } else {
    shutdown(guildId, queue);
  }
}

async function playSong(guildId, song) {
  const queue = queues.get(guildId);
  if (!queue || !queue.player || !queue.connection || queue.stopped) return;

  if (queue._destroyTimer) { clearTimeout(queue._destroyTimer); queue._destroyTimer = null; }

  try {
    const id = ++queue._streamSeq;
    const { stream, cleanup } = createYtdlpStream(song.url, (err) => {
      if (queue._streamSeq !== id) return; // สตรีมเก่า ไม่เกี่ยวแล้ว
      if (!queue._pendingError) queue._pendingError = { song, err };
    });

    const resource = createAudioResource(stream, {
      inputType   : StreamType.Raw,
      inlineVolume: true,
    });
    resource.volume?.setVolume(queue.volume / 100);

    const oldCleanup = queue._cleanupStream;
    queue._cleanupStream = cleanup;
    queue.resource    = resource;
    queue.startedAt   = 0;
    queue.totalPaused = 0;
    queue.pausedAt    = 0;
    queue._trackStart = true;
    queue._pendingError = null;

    queue.player.play(resource);
    queue.isPlaying = true;
    if (oldCleanup) { try { oldCleanup(); } catch {} }

    if (queue._restoreLoop !== null) {
      queue.loop = queue._restoreLoop;
      queue._restoreLoop = null;
    }

    await sendOrUpdatePlayerCard(queue, song);
    startProgressUpdater(queue);
  } catch (err) {
    failTrack(guildId, queue, song, err);
  }
}

function attachPlayerEvents(guildId, player, connection) {
  const queue = getQueue(guildId);
  queue.player     = player;
  queue.connection = connection;

  let voiceWatchdog = null;
  let wasReady = false;
  let rejoinTried = false;
  const clearWatchdog = () => {
    if (voiceWatchdog) { clearTimeout(voiceWatchdog); voiceWatchdog = null; }
  };
  const armWatchdog = () => {
    clearWatchdog();
    voiceWatchdog = setTimeout(() => {
      voiceWatchdog = null;
      const st = connection.state.status;
      if (st === VoiceConnectionStatus.Ready || st === VoiceConnectionStatus.Destroyed) return;
      if (!rejoinTried) {
        rejoinTried = true;
        console.error(`⚠️ Voice ค้างที่ ${st} นาน 15s — ลอง rejoin`);
        try { connection.rejoin(); } catch (e) { console.error("rejoin error:", e.message); }
        armWatchdog();
      } else {
        console.error(`❌ Voice ไม่กลับมา Ready (ค้างที่ ${st}) — ปิดคิว`);
        if (queue.textChannel) {
          queue.textChannel.send({
            flags: FLAGS.V2,
            components: [msgCard("- `❌` **การเชื่อมต่อห้องเสียงหลุด — หยุดเล่นแล้ว กรุณาค้นหาเพลงใหม่**")],
          }).catch(() => {});
        }
        shutdown(guildId, queue);
      }
    }, 15_000);
  };

  connection.on("stateChange", (o, n) => {
    console.log(`[voice]  ${o.status} -> ${n.status}`);
    if (n.status === VoiceConnectionStatus.Ready) {
      wasReady = true;
      rejoinTried = false;
      clearWatchdog();
    } else if (n.status === VoiceConnectionStatus.Destroyed) {
      clearWatchdog();
    } else if (wasReady && n.status !== VoiceConnectionStatus.Disconnected && !voiceWatchdog) {
      armWatchdog();
    }
  });
  connection.on("error", (e) => console.error("[voice] error:", e.message));
  player.on("stateChange", (o, n) => console.log(`[player] ${o.status} -> ${n.status}`));

  player.on(AudioPlayerStatus.Playing, () => {
    queue.isPlaying   = true;
    queue.isBuffering = false;
    queue._retried    = false;
    if (queue._destroyTimer) { clearTimeout(queue._destroyTimer); queue._destroyTimer = null; }
    if (queue._trackStart) {
      queue._trackStart = false;
      queue.startedAt   = Date.now();
    }
    if (queue.pausedAt) {
      queue.totalPaused += Date.now() - queue.pausedAt;
      queue.pausedAt = 0;
    }
    refreshCard(queue);
  });

  const onPause = () => {
    if (!queue.pausedAt) queue.pausedAt = Date.now();
    queue.isPlaying = false;
  };
  player.on(AudioPlayerStatus.Paused, onPause);
  player.on(AudioPlayerStatus.AutoPaused, onPause);

  player.on(AudioPlayerStatus.Buffering, () => {
    queue.isBuffering = true;
    refreshCard(queue);
  });

  player.on("error", (err) => {
    console.error("❌ Player error:", err.message);
    if (!queue._pendingError) queue._pendingError = { song: queue.current, err };
  });

  player.on(AudioPlayerStatus.Idle, () => {
    queue.isPlaying   = false;
    queue.isBuffering = false;
    queue.killStream();

    if (queue.stopped) return;

    if (queue._jumping) {
      queue._jumping = false;
      queue._pendingError = null;
      const s = queue.current;
      if (s) playSong(guildId, s);
      return;
    }

    if (queue._pendingError) {
      const { song, err } = queue._pendingError;
      queue._pendingError = null;
      failTrack(guildId, queue, song || queue.current, err);
      return;
    }

    const force = queue._forceNext;
    queue._forceNext = false;
    const next = queue.next(force);
    if (next) {
      playSong(guildId, next);
    } else {
      stopProgressUpdater(queue);
      deleteCard(queue);
      queue._destroyTimer = setTimeout(() => shutdown(guildId, queue), 30_000);
    }
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      shutdown(guildId, queue);
    }
  });

  connection.on(VoiceConnectionStatus.Destroyed, () => {
    stopProgressUpdater(queue);
    if (queue._destroyTimer) { clearTimeout(queue._destroyTimer); queue._destroyTimer = null; }
    queue.killStream();
    deleteCard(queue);
    queue.player     = null;
    queue.connection = null;
    queue.resource   = null;
    queue.clear();
    if (queues.get(guildId) === queue) queues.delete(guildId);
  });

  connection.subscribe(player);
}

async function joinVoiceFromInteraction(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) throw new Error("คุณต้องอยู่ใน Voice Channel ก่อน!");

  const queue = getQueue(interaction.guildId);
  queue.stopped     = false;
  queue.textChannel = interaction.channel;

  if (queue.connection && queue.connection.joinConfig.channelId !== voiceChannel.id) {
    throw new Error("บอทกำลังเล่นเพลงอยู่ในห้องเสียงอื่น");
  }

  if (!queue.connection) {
    const connection = joinVoiceChannel({
      channelId     : voiceChannel.id,
      guildId       : interaction.guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf      : true,
      selfMute      : false,
    });

    const player = createAudioPlayer();
    attachPlayerEvents(interaction.guildId, player, connection);

    queue.ready = entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT)
      .catch(() => {
        console.error(`❌ Voice connection ไม่ถึง Ready ใน ${VOICE_READY_TIMEOUT / 1000}s (สถานะ: ${connection.state.status}) — มักเป็นปัญหา UDP/เครือข่ายของโฮสต์ หรือขาด @snazzah/davey`);
        try { connection.destroy(); } catch {}
        throw new Error("เชื่อมต่อห้องเสียงไม่สำเร็จ (Voice ไม่ Ready)");
      });
  }

  await queue.ready;
  return queue;
}

async function enqueueAndPlay(guildId, queue, song) {
  queue.add(song);
  const idle = queue.player?.state.status === AudioPlayerStatus.Idle;
  if (idle) {
    queue.currentIdx = queue.songs.length - 1;
    queue._retried = false;
    await playSong(guildId, song);
    return "start";
  }
  refreshCard(queue);
  return "queued";
}

const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("🎵 สร้างห้อง Music และส่งแผงควบคุมเพลง")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log("✅  Slash commands ลงทะเบียนแล้ว");
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

const normText = (n) => n.toLowerCase().replace(/\s+/g, "-");

async function handleSetup(interaction) {
  const guild = interaction.guild;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    await guild.channels.fetch();

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

    const textName = normText(MUSIC_CONFIG.TEXT_CHANNEL_NAME);
    let textChannel = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && c.name === textName
    );
    if (!textChannel) {
      textChannel = await guild.channels.create({
        name: MUSIC_CONFIG.TEXT_CHANNEL_NAME,
        type: ChannelType.GuildText,
        parent: category.id,
      });
    }

    await textChannel.send({ flags: FLAGS.V2, components: [buildSetupContainer()] });

    const logLine = LOG_CHANNEL_ID
      ? `\n🎵 **ห้องการ์ดเพลง:** <#${LOG_CHANNEL_ID}>`
      : "\n⚠️ ยังไม่ได้ตั้ง LOG_CHANNEL_ID (การ์ดจะส่งในห้องคำสั่ง)";

    await interaction.editReply({
      content: `✅ สร้างห้องสำเร็จ!\n📢 **ห้องเสียง:** <#${voiceChannel.id}>\n💬 **ห้องคำสั่ง:** <#${textChannel.id}>${logLine}`,
    });

    setTimeout(() => interaction.deleteReply().catch(() => {}), 5000);
  } catch (e) {
    console.error("❌ handleSetup error:", e);
    await interaction.editReply({ content: `❌ เกิดข้อผิดพลาด: ${e.message}` }).catch(() => {});
  }
}

async function onInteraction(interaction) {
  const guildId = interaction.guildId;
  if (!guildId) return;

  if (interaction.isChatInputCommand() && interaction.commandName === "setup") {
    return handleSetup(interaction);
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "search_select") {
    const key     = pKey(guildId, interaction.user.id);
    const pending = pendingSearch.get(key);
    if (!pending) {
      return interaction.reply(replyEph("- `❌` **หมดเวลาเลือกเพลง — ค้นหาใหม่**"));
    }

    const picked = pending.results[parseInt(interaction.values[0], 10)];
    if (!picked) {
      return interaction.reply(replyEph("- `❌` **ไม่พบเพลงที่เลือก**"));
    }

    if (!interaction.member?.voice?.channel) {
      return interaction.reply(replyEph("- `❌` **คุณต้องอยู่ใน Voice Channel ก่อน!**"));
    }

    await interaction.deferUpdate();

    let queue;
    try {
      queue = await joinVoiceFromInteraction(interaction);
    } catch (e) {
      return interaction.editReply(editCard(`- \`❌\` **${e.message}**`));
    }

    clearPendingSearch(key);

    const song = { ...picked, requester: interaction.user.id };
    const result = await enqueueAndPlay(guildId, queue, song);
    return interaction.editReply(editCard(
      result === "start"
        ? `- \`✅\` **เริ่มเล่น** **${song.title}**`
        : `- \`✅\` **เพิ่มเข้าคิว:** **${song.title}**`
    ));
  }

  if (interaction.isButton()) {
    const { customId } = interaction;

    if (customId === "setup_search") {
      return interaction.showModal(
        buildModal("setup_search", "🔍 ค้นหาเพลง", "ชื่อเพลงที่ต้องการ", "เช่น pun")
      );
    }

    if (customId === "search_prev" || customId === "search_next") {
      const pending = pendingSearch.get(pKey(guildId, interaction.user.id));
      if (!pending) {
        return interaction.reply(replyEph("- `❌` **หมดเวลาเลือกเพลง — ค้นหาใหม่**"));
      }
      const totalPages = Math.max(1, Math.ceil(pending.results.length / SEARCH_PAGE_SIZE));
      pending.page = Math.min(totalPages - 1, Math.max(0, pending.page + (customId === "search_next" ? 1 : -1)));
      return interaction.update({
        components: [buildSearchContainer(pending.results, pending.query, pending.page)],
      });
    }

    if (!customId.startsWith("music_")) return;

    const queue = queues.get(guildId);
    if (!queue || !queue.player) {
      return interaction.reply({ content: "- `❌` **ไม่มีเพลงเล่นอยู่**", flags: MessageFlags.Ephemeral });
    }

    const userVc = interaction.member?.voice?.channelId;
    if (!userVc || userVc !== queue.connection?.joinConfig.channelId) {
      return interaction.reply({ content: "- `❌` **ต้องอยู่ในห้องเสียงเดียวกับบอทถึงจะควบคุมได้**", flags: MessageFlags.Ephemeral });
    }

    const ephemeral = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

    if (customId === "music_playpause") {
      const status = queue.player.state.status;
      if (status === AudioPlayerStatus.Paused || status === AudioPlayerStatus.AutoPaused) {
        queue.player.unpause();
        return ephemeral("▶️ เล่นต่อ");
      }
      if (status === AudioPlayerStatus.Playing || status === AudioPlayerStatus.Buffering) {
        queue.player.pause();
        return ephemeral("⏸️ พักแล้ว");
      }
      return ephemeral("- `❌` **ไม่มีเพลงกำลังเล่นอยู่**");
    }

    if (customId === "music_skip") {
      if (queue.player.state.status === AudioPlayerStatus.Idle) {
        return ephemeral("- `❌` **ไม่มีเพลงกำลังเล่นอยู่**");
      }
      queue._forceNext = true; 
      queue.player.stop(true);
      return ephemeral("⏭️ ข้ามแล้ว!");
    }

    if (customId === "music_prev") {
      if (queue.currentIdx <= 0) return ephemeral("- `❌` **ไม่มีเพลงก่อนหน้า**");
      queue._restoreLoop = queue.loop; 
      queue.loop = false;
      queue.currentIdx -= 1;
      if (queue.player.state.status === AudioPlayerStatus.Idle) {
        playSong(guildId, queue.current);
      } else {
        queue._jumping = true;
        queue.player.stop(true);
      }
      return ephemeral("- `⏮️` **เพลงก่อนหน้า!**");
    }

    if (customId === "music_shuffle") {
      if (queue.songs.length <= 1) return ephemeral("- `❌` **มีเพลงไม่พอสุ่ม**");
      queue.shuffle();
      refreshCard(queue);
      return ephemeral("- `🔀` **สุ่มคิวแล้ว!**");
    }

    if (customId === "music_loop") {
      let mode;
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
      return ephemeral(mode);
    }

    if (customId === "music_vol_up" || customId === "music_vol_down") {
      const delta = customId === "music_vol_up" ? 10 : -10;
      queue.volume = Math.min(100, Math.max(0, queue.volume + delta));
      queue.resource?.volume?.setVolume(queue.volume / 100);
      refreshCard(queue);
      return ephemeral(`- \`${delta > 0 ? "🔊" : "🔉"}\` **${queue.volume}** **%**`);
    }

    if (customId === "music_stop") {
      await shutdown(guildId, queue);
      return ephemeral("- `🛑` **หยุดเล่นแล้ว!**");
    }

    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === "setup_search") {
    const inputVal = interaction.fields.getTextInputValue("input").trim();

    if (!interaction.member?.voice?.channel) {
      return interaction.reply({
        content: "- `❌` **คุณต้องอยู่ใน Voice Channel ก่อน!**",
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.reply(replyEph("- `🔍` **กำลังค้นหา...**"));

    try {
      const res = await searchTracks(inputVal, interaction.user.id);

      if (!res.tracks.length) {
        return interaction.editReply(editCard("- `❌` **ไม่พบผลการค้นหา**"));
      }

      if (res.type === "track") {
        let queue;
        try {
          queue = await joinVoiceFromInteraction(interaction);
        } catch (e) {
          return interaction.editReply(editCard(`- \`❌\` **${e.message}**`));
        }
        const song = res.tracks[0];
        const result = await enqueueAndPlay(guildId, queue, song);
        return interaction.editReply(editCard(
          result === "start"
            ? `- \`✅\` **เริ่มเล่น** **${song.title}**`
            : `- \`✅\` **เพิ่มเข้าคิว:** **${song.title}**`
        ));
      }

      setPendingSearch(pKey(guildId, interaction.user.id), { results: res.tracks, query: inputVal, page: 0 });
      await interaction.editReply({
        flags: FLAGS.V2,
        components: [buildSearchContainer(res.tracks, inputVal, 0)],
      });
    } catch (e) {
      console.error("❌ Modal submit error:", e);
      await interaction.editReply(editCard(`- \`❌\` ${e.message}`)).catch(() => {});
    }
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    await onInteraction(interaction);
  } catch (e) {
    console.error("❌ Interaction error:", e);
    try {
      const payload = replyEph(`- \`❌\` **เกิดข้อผิดพลาด:** ${String(e.message).slice(0, 200)}`);
      if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } catch {}
  }
});

process.on("unhandledRejection", (r) => console.error("UnhandledRejection:", r));
process.on("uncaughtException", (e) => {
  if (e && (e.code === "EPIPE" || e.code === "ENOENT")) {
    console.error("UncaughtException (ignored):", e.code, e.message);
    return;
  }
  console.error("UncaughtException:", e);
});

async function gracefulExit(sig) {
  console.log(`\n👋 ได้รับ ${sig} กำลังปิดบอท...`);
  for (const [gid, q] of [...queues.entries()]) {
    await shutdown(gid, q).catch(() => {});
  }
  process.exit(0);
}
process.on("SIGINT",  () => gracefulExit("SIGINT"));
process.on("SIGTERM", () => gracefulExit("SIGTERM")); 

function updatePresence() {
  if (!client.user) return;
  const servers = client.guilds.cache.size;
  const members = client.guilds.cache.reduce((sum, g) => sum + (g.memberCount || 0), 0);
  client.user.setPresence({
    status: "online",
    activities: [{
      name: `${servers} servers | ${members} members`,
      type: ActivityType.Listening,
    }],
  });
}

client.once(Events.ClientReady, async (c) => {
  console.log(`\n🎵  ${c.user.tag} พร้อมใช้งานแล้ว!`);
  updatePresence();
  setInterval(updatePresence, 5 * 60 * 1000); 
  try {
    await registerCommands();
  } catch (e) {
    console.error("❌ ลงทะเบียน slash commands ไม่สำเร็จ:", e.message);
  }
});

client.login(TOKEN);
