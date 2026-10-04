require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder,
    PermissionFlagsBits,
} = require('discord.js');

const {
    createAudioPlayer,
    createAudioResource,
    joinVoiceChannel,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState,
    StreamType,
    NoSubscriberBehavior,
} = require('@discordjs/voice');

const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const execFileAsync = promisify(execFile);

// ─── Настройки ──────────────────────────────────────────────────────

const SETTINGS_FILE = './settings.json';

// Пишем во временный файл рядом и подменяем одним rename: сбой посередине записи
// больше не оставит битый settings.json или обрезанный .env со всеми ключами
function writeFileAtomic(file, data, mode = 0o644) {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, file);
}

function loadSettings() {
    try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
    catch { return {}; }
}

function saveSetting(guildId, key, value) {
    const settings = loadSettings();
    if (!settings[guildId]) settings[guildId] = {};
    settings[guildId][key] = value;
    try { writeFileAtomic(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch {}
}

function getSetting(guildId, key, defaultValue) {
    const settings = loadSettings();
    return settings[guildId]?.[key] ?? defaultValue;
}

// ─── Клиент ───────────────────────────────────────────────────────────────────

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
    allowedMentions: { parse: [] },  // никого не пингуем текстом: названия треков и ошибки приходят извне
});

// Ошибка в одном обработчике не должна ронять бота на всех серверах
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.message || e));

// В чат - только свои понятные ошибки; вывод yt-dlp (пути, куки, прокси) - в журнал
function safeErr(e) {
    const m = String(e?.message || '');
    if (e?.cmd || e instanceof SyntaxError || /Command failed|\/root|cookies|socks5|\/tmp/.test(m)) return 'не получилось загрузить';
    return m.slice(0, 200) || 'ошибка';
}

// ─── Spotify API ──────────────────────────────────────────────────────────────

let _spotifyToken = null;
let _spotifyTokenExpiry = 0;

function httpsPost(url, headers, body) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const req = https.request(
            {
                hostname: parsed.hostname,
                path: parsed.pathname,
                method: 'POST',
                headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
            },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch { reject(new Error('Spotify: invalid JSON')); }
                });
            }
        );
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function httpsGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve(httpsGet(res.headers.location, headers));
            }
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch { reject(new Error('Spotify: invalid JSON')); }
            });
        }).on('error', reject);
    });
}

async function getSpotifyToken() {
    if (_spotifyToken && Date.now() < _spotifyTokenExpiry) return _spotifyToken;

    const id      = process.env.SPOTIFY_CLIENT_ID;
    const secret  = process.env.SPOTIFY_CLIENT_SECRET;
    const refresh = process.env.SPOTIFY_REFRESH_TOKEN;

    if (!id || !secret) throw new Error('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not set in .env');
    if (!refresh) throw new Error('SPOTIFY_REFRESH_TOKEN not set. Run: node spotify-auth.js');

    const creds = Buffer.from(`${id}:${secret}`).toString('base64');
    const data  = await httpsPost(
        'https://accounts.spotify.com/api/token',
        { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        `grant_type=refresh_token&refresh_token=${encodeURIComponent(refresh)}`
    );

    if (!data.access_token) throw new Error(`Spotify auth failed: ${data.error_description ?? data.error}`);

    if (data.refresh_token && data.refresh_token !== refresh) {
        try {
            let env = fs.readFileSync('.env', 'utf8');
            env = env.replace(/SPOTIFY_REFRESH_TOKEN=.*/, `SPOTIFY_REFRESH_TOKEN=${data.refresh_token}`);
            writeFileAtomic('.env', env, 0o600);
            process.env.SPOTIFY_REFRESH_TOKEN = data.refresh_token;
        } catch {}
    }

    _spotifyToken = data.access_token;
    _spotifyTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return _spotifyToken;
}

async function spotifyGet(path) {
    const token = await getSpotifyToken();
    const { status, body } = await httpsGet(
        `https://api.spotify.com/v1${path}`,
        { Authorization: `Bearer ${token}` }
    );
    if (status === 401) { _spotifyToken = null; return spotifyGet(path); }
    if (status >= 400) throw new Error(`Spotify API error ${status}: ${body?.error?.message ?? ''}`);
    return body;
}

function parseSpotifyUrl(url) {
    const m = url.match(/open\.spotify\.com\/(track|album|playlist)\/([A-Za-z0-9]+)/);
    if (!m) return null;
    return { type: m[1], id: m[2] };
}

function spotifyTrackDesc(t, albumThumbnail = null) {
    if (!t || !t.name) return null;
    const thumbnail =
        t.album?.images?.[0]?.url ||   // полный объект трека
        albumThumbnail ||               // передаётся при загрузке альбома/плейлиста
        null;
    return {
        title: t.name,
        author: t.artists?.[0]?.name ?? 'Unknown',
        duration: t.duration_ms ? parseDuration(t.duration_ms / 1000) : '?:??',
        durationSec: t.duration_ms ? Math.round(t.duration_ms / 1000) : 0,
        url: null,
        spotifySearch: `${t.name} ${t.artists?.[0]?.name ?? ''}`.trim(),
        requestedBy: null,
        thumbnail,
        spotifyUrl: t.id ? `https://open.spotify.com/track/${t.id}` : null,
    };
}

async function fetchSpotifyTrack(id) {
    const data = await spotifyGet(`/tracks/${id}`);
    const desc = spotifyTrackDesc(data);
    return desc ? [desc] : [];
}

async function fetchSpotifyAlbum(id) {
    const data = await spotifyGet(`/albums/${id}?market=ES`);
    const albumThumbnail = data.images?.[0]?.url ?? null;
    return (data.tracks?.items ?? []).map((t) => spotifyTrackDesc(t, albumThumbnail)).filter(Boolean);
}

function httpsGetHtml(url, headers = {}) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve(httpsGetHtml(res.headers.location, headers));
            }
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve({ status: res.statusCode, html: data }));
        }).on('error', reject);
    });
}

function getSpotifyCookieForGuild(guildId) {
    if (!guildId) return process.env.SPOTIFY_SP_DC || null;
    const accountNum = getSetting(guildId, 'spotifyAccount', null);
    if (accountNum) return process.env[`SPOTIFY_SP_DC_${accountNum}`] || null;
    return process.env.SPOTIFY_SP_DC || null;
}

async function fetchSpotifyPlaylist(id, guildId = null) {
    // 1) Пробуем официальный API (работает для собственных плейлистов с нужными правами)
    try {
        const tracks = [];
        let path = `/playlists/${id}/tracks?limit=100&fields=next,items(track(name,artists,duration_ms,album(images)))`;
        while (path) {
            const data = await spotifyGet(path);
            for (const item of (data.items ?? [])) {
                if (item.track) { const d = spotifyTrackDesc(item.track); if (d) tracks.push(d); }
            }
            path = data.next ? data.next.replace('https://api.spotify.com/v1', '') : null;
        }
        if (tracks.length) return tracks;
    } catch (err) {
        console.error('Spotify API playlist error (переходим на embed):', err.message);
    }

    // 2) Фоллбэк — публичная embed-страница (без OAuth, без лимитов Development mode)
    const embedHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    };
    // Если задан sp_dc cookie — embed-страница увидит нас как залогиненного пользователя
    // и сможет отдать приватные/непубличные плейлисты владельца этого аккаунта.
    // Для многосерверных ботов можно назначить свой аккаунт каждому серверу через /settings spotify_account
    const spDc = getSpotifyCookieForGuild(guildId);
    if (spDc) {
        embedHeaders['Cookie'] = `sp_dc=${spDc}`;
    }
    const { status, html } = await httpsGetHtml(`https://open.spotify.com/embed/playlist/${id}`, embedHeaders);
    if (status >= 400) throw new Error(`Spotify embed недоступен (${status}) — если плейлист приватный, добавь SPOTIFY_SP_DC в .env`);

    const match = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) throw new Error('Не удалось найти данные плейлиста на странице Spotify');

    let json;
    try { json = JSON.parse(match[1]); } catch { throw new Error('Не удалось разобрать данные плейлиста'); }

    const entity = json?.props?.pageProps?.state?.data?.entity;
    const items = entity?.trackList ?? [];
    if (!items.length) throw new Error('Плейлист пуст или недоступен');

    return items.map((t) => ({
        title: t.title ?? 'Unknown',
        author: t.subtitle ?? 'Unknown',
        duration: t.duration ? parseDuration(t.duration / 1000) : '?:??',
        durationSec: t.duration ? Math.round(t.duration / 1000) : 0,
        url: null,
        spotifySearch: `${t.title ?? ''} ${t.subtitle ?? ''}`.trim(),
        requestedBy: null,
        thumbnail: entity.coverArt?.sources?.[0]?.url ?? null,
        spotifyUrl: t.uri ? `https://open.spotify.com/track/${t.uri.split(':').pop()}` : null,
        isTempFile: false,
    })).filter((t) => t.spotifySearch);
}

// ─── Telegram ────────────────────────────────────────────────────────────────

let _tgClient = null;

async function getTgClient() {
    if (_tgClient) return _tgClient;
    const { TelegramClient } = require('telegram');
    const { StringSession } = require('telegram/sessions');
    const apiId   = parseInt(process.env.TG_API_ID);
    const apiHash = process.env.TG_API_HASH;
    const session = process.env.TG_SESSION;
    if (!apiId || !apiHash || !session)
        throw new Error('TG_API_ID, TG_API_HASH или TG_SESSION не найдены в .env — запусти node tg-auth.js');
    const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 3 });
    await client.connect();
    _tgClient = client;
    return client;
}

function parseTgUrl(url) {
    // https://t.me/channel/123 или https://t.me/c/chatId/123
    const m = url.match(/t\.me\/(?:c\/(\d+)|([^/?]+))\/(\d+)/);
    if (!m) return null;
    return { channel: m[1] ? parseInt(m[1]) : m[2], messageId: parseInt(m[3]) };
}

async function fetchTelegramMedia(url) {
    const parsed = parseTgUrl(url);
    if (!parsed) throw new Error('Неверная ссылка Telegram — нужна ссылка на конкретное сообщение');

    // Сессия - личный аккаунт: без проверки любой из Discord вытащил бы медиа из его
    // приватных чатов (t.me/c/...) и переписок (t.me/<username человека>/<id>)
    if (typeof parsed.channel !== 'string') throw new Error('Только публичные каналы и группы Telegram');
    const client = await getTgClient();
    const ent = await client.getEntity(parsed.channel);
    if (ent?.className !== 'Channel' || !ent.username) throw new Error('Только публичные каналы и группы Telegram');
    const messages = await client.getMessages(ent, { ids: [parsed.messageId] });
    const msg = messages[0];
    if (!msg)        throw new Error('Сообщение не найдено');
    if (!msg.media)  throw new Error('В сообщении нет медиафайла');

    const size = Number(msg.media.document?.size?.toString?.() ?? msg.media.document?.size ?? 0);
    if (size > 50 * 1024 * 1024) throw new Error('Файл больше 50 МБ');
    const tmpFile = path.join(os.tmpdir(), `fm-tg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await client.downloadMedia(msg.media, { outputFile: tmpFile });
    // Файл из чужого канала: ffmpeg определяет формат по содержимому и мог бы принять его за
    // плейлист (HLS/concat) со ссылками на локальные файлы. Пропускаем только настоящие медиаформаты
    try {
        const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name',
            '-of', 'default=nw=1:nk=1', tmpFile], { timeout: 20_000 });
        if (!/^(mp3|ogg|flac|wav|aac|asf|matroska,webm|mov,mp4,m4a,3gp,3g2,mj2)$/.test(stdout.trim())) throw new Error('format');
    } catch {
        try { fs.unlinkSync(tmpFile); } catch {}
        throw new Error('Это не аудиофайл');
    }

    // Получаем метаданные из атрибутов документа
    let title  = 'Telegram Audio';
    let author = String(parsed.channel);
    let duration = '?:??';
    let durationSec = 0;
    let tgUrl = url;

    const doc = msg.media.document;
    if (doc?.attributes) {
        for (const attr of doc.attributes) {
            if (attr.title)     title    = attr.title;
            if (attr.performer) author   = attr.performer;
            if (attr.duration)  { duration = parseDuration(attr.duration); durationSec = Math.round(attr.duration); }
        }
    }
    if (title === 'Telegram Audio' && msg.message) {
        title = msg.message.split('\n')[0].slice(0, 100) || 'Telegram Audio';
    }

    return [{
        title,
        author,
        duration,
        durationSec,
        url: tmpFile,
        spotifySearch: null,
        requestedBy: null,
        thumbnail: null,
        spotifyUrl: null,
        tgUrl,
        isTempFile: true,
    }];
}

// ─── Embed и кнопки ──────────────────────────────────────────────

const NP_GIF = 'https://c.tenor.com/fdHXQgnfQGUAAAAC/tenor.gif';

// ─── Прогресс-бар ──────────────────────────────────────────────────────────

let _canvasLib = null;
let _canvasTried = false;
function tryLoadCanvas() {
    if (_canvasTried) return _canvasLib;
    _canvasTried = true;
    try { _canvasLib = require('canvas'); } catch { _canvasLib = null; }
    return _canvasLib;
}

function getElapsedSeconds(queue) {
    if (!queue.trackStartedAt) return 0;
    const end = queue.paused && queue.pausedAt ? queue.pausedAt : Date.now();
    return Math.max(0, Math.floor((end - queue.trackStartedAt) / 1000));
}

function buildTextProgressBar(queue, track) {
    const total = track.durationSec || 0;
    if (!total) return null;
    const elapsed = Math.min(getElapsedSeconds(queue), total);
    const barLen = 20;
    const pos = Math.round((elapsed / total) * (barLen - 1));
    let bar = '';
    for (let i = 0; i < barLen; i++) bar += i === pos ? '●' : '▬';
    return `${bar}\n${parseDuration(elapsed)} / ${track.duration}`;
}

async function buildImageProgressBar(queue, track) {
    const canvas = tryLoadCanvas();
    if (!canvas) return null;
    const total = track.durationSec || 0;
    if (!total) return null;
    const elapsed = Math.min(getElapsedSeconds(queue), total);
    const progress = elapsed / total;

    const W = 500, H = 60;
    const cnv = canvas.createCanvas(W, H);
    const ctx = cnv.getContext('2d');

    const barX = 10, barY = 30, barW = 480, barH = 6;
    ctx.fillStyle = '#4f545c';
    roundRect(ctx, barX, barY, barW, barH, 3);
    ctx.fill();

    const fillW = Math.max(6, Math.round(barW * progress));
    ctx.fillStyle = '#1db954';
    roundRect(ctx, barX, barY, fillW, barH, 3);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(barX + fillW, barY + barH / 2, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    ctx.fillStyle = '#949ba4';
    ctx.font = '16px sans-serif';
    ctx.fillText(parseDuration(elapsed), barX, barY + 30);
    const rightLabel = track.duration;
    const rightWidth = ctx.measureText(rightLabel).width;
    ctx.fillText(rightLabel, barX + barW - rightWidth, barY + 30);

    return cnv.toBuffer('image/png');
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function buildEmbed(queue, guildId = null) {
    const track = queue.tracks[0];
    if (!track) return new EmbedBuilder().setDescription('Ничего не играет');

    const volLabel = queue.muted ? '🔇 Замучен' : `🔊 ${Math.round(queue.volume * 100)}%`;
    const barMode = getSetting(guildId, 'progressBar', 'off');

    const embed = new EmbedBuilder()
        .setColor(0x1DB954)
        .setAuthor({ name: '🎵 Сейчас играет' })
        .setTitle(track.title.slice(0, 256))
        .setDescription(`**${track.author}**`)
        .addFields(
            { name: 'Запросил', value: track.requestedBy ?? 'Неизвестно', inline: true },
            { name: 'Длительность', value: track.duration,                  inline: true },
            { name: 'Статус',       value: queue.paused ? '⏸ Пауза' : '▶️ Играет', inline: true },
        )
        .setThumbnail(track.thumbnail ?? null)
        .setFooter({ text: `Повтор: ${queue.loop ? 'ВКЛ 🔁' : 'ВЫКЛ'} • Случайный: ${queue.shuffle ? 'ВКЛ 🔀' : 'ВЫКЛ'} • ${volLabel}` });

    if (barMode === 'text') {
        const bar = buildTextProgressBar(queue, track);
        if (bar) embed.addFields({ name: '\u200b', value: bar });
        embed.setImage(NP_GIF);
    } else if (barMode === 'image') {
        // setImage будет заменён на attachment:// в updateNowPlayingMsg
        embed.setImage('attachment://progress.png');
    } else {
        embed.setImage(NP_GIF);
    }

    return embed;
}

function buildComponents(queue) {
    const B = (id, emoji, style) =>
        new ButtonBuilder().setCustomId(id).setEmoji(emoji).setStyle(style);
    const BL = (id, label, style) =>
        new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

    const row1 = new ActionRowBuilder().addComponents(
        B('btn_prev',  '⏮️', ButtonStyle.Secondary),
        B(queue.paused ? 'btn_resume' : 'btn_pause', queue.paused ? '▶️' : '⏸️',
          queue.paused ? ButtonStyle.Success : ButtonStyle.Secondary),
        B('btn_skip',  '⏭️', ButtonStyle.Secondary),
    );

    const row2 = new ActionRowBuilder().addComponents(
        B('btn_mute',     '🔇', queue.muted ? ButtonStyle.Danger : ButtonStyle.Secondary),
        B('btn_vol_down', '🔉', ButtonStyle.Secondary),
        B('btn_vol_up',   '🔊', ButtonStyle.Secondary),
    );

    const row3 = new ActionRowBuilder().addComponents(
        B('btn_queue',  '📋', ButtonStyle.Secondary),
        B('btn_save',   '💾', ButtonStyle.Secondary),
        BL('btn_loop',  '♾️',  queue.loop    ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );

    const row4 = new ActionRowBuilder().addComponents(
        B('btn_replay',   '🔁', ButtonStyle.Secondary),
        B('btn_stop',     '⏹️', ButtonStyle.Danger),
        B('btn_shuffle',  '🔀', queue.shuffle ? ButtonStyle.Primary : ButtonStyle.Secondary),
    );

    return [row1, row2, row3, row4];
}

async function updateNowPlayingMsg(queue, guildId = null) {
    if (!queue.controlPanels.length) return;
    const embed = buildEmbed(queue, guildId);
    const barMode = getSetting(guildId, 'progressBar', 'off');
    // files: [] явно очищает старые вложения (например картинку прогресс-бара
    // от прошлого режима) — без этого Discord оставляет их висеть отдельно
    const payload = { embeds: [embed], components: buildComponents(queue), files: [] };

    if (barMode === 'image') {
        const track = queue.tracks[0];
        const buf = track ? await buildImageProgressBar(queue, track).catch(() => null) : null;
        if (buf) {
            payload.files = [new AttachmentBuilder(buf, { name: 'progress.png' })];
        } else {
            embed.setImage(NP_GIF); // canvas недоступен или нет длительности — fallback на гифку
        }
    }

    await Promise.all(queue.controlPanels.map((msg) => msg.edit(payload).catch(() => {})));
}

function pruneControlPanels(queue) {
    queue.controlPanels = queue.controlPanels.filter((msg) => {
        try { return !!msg.id; } catch { return false; }
    });
}

async function closeControlPanels(queue, text) {
    await Promise.all(queue.controlPanels.map((msg) =>
        msg.edit({ content: text || null, embeds: [], components: [], files: [] }).catch(() => {})
    ));
    queue.controlPanels = [];
}

// ─── Очередь ────────────────────────────────────────────────────────────────────

const queues = new Map();

function getQueue(guildId) { return queues.get(guildId); }

function destroyQueue(guildId, stoppedBy = null) {
    const queue = queues.get(guildId);
    if (!queue) return;
    queue.destroyed = true;
    killCurrent(queue);
    cleanupPrefetch(queue);
    for (const t of queue.tracks) {
        if (t.isTempFile && t.url) { try { fs.unlinkSync(t.url); } catch {} }
    }
    queue.tracks = [];
    closeControlPanels(queue, stoppedBy ? `⏹ Остановлено — ${stoppedBy}` : '⏹ Остановлено').catch(() => {});
    queue.player.stop(true);
    queue.connection.destroy();
    queues.delete(guildId);
}

function killCurrent(queue) {
    if (queue.currentProcess) {
        try { queue.currentProcess.ytProc?.kill('SIGKILL'); } catch {}
        try { queue.currentProcess.ffProc?.kill('SIGKILL'); } catch {}
        queue.currentProcess = null;
    }
}

function applyShuffleIfNeeded(queue) {
    if (queue.shuffle && queue.tracks.length > 1) {
        const idx = Math.floor(Math.random() * queue.tracks.length);
        const next = queue.tracks.splice(idx, 1)[0];
        queue.tracks.unshift(next);
    }
}

function setVolume(queue) {
    if (!queue.currentResource?.volume) return;
    queue.currentResource.volume.setVolume(queue.muted ? 0 : queue.volume);
}

function createQueue(guildId, connection, textChannel) {
    const player = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    const queue = {
        guildId,
        tracks: [],
        history: [],          // последние 10 треков
        player,
        connection,
        textChannel,
        playing: false,
        paused: false,
        currentProcess: null,
        currentResource: null,
        isTransitioning: false,
        destroyed: false,
        loop: false,
        shuffle: false,
        volume: getSetting(guildId, 'volume', 0.8),
        muted: false,
        controlPanels: [],   // все активные панели управления
        prefetchProcess: null,
        prefetchFile: null,
        prefetchReady: false,
        stayInVoice: false,
    };
    queues.set(guildId, queue);

    player.on('stateChange', (oldState, newState) => {
        if (newState.status !== AudioPlayerStatus.Idle) return;
        if (oldState.status === AudioPlayerStatus.Idle) return;
        if (queue.destroyed) return;
        if (queue.isTransitioning) return;
        queue.isTransitioning = true;
        queue.currentProcess = null;
        queue.currentResource = null;
        queue.paused = false;

        // Повтор — запускаем тот же трек
        if (queue.loop && queue.tracks.length > 0) {
            playNext(guildId);
            return;
        }

        // Сохраняем в историю
        if (queue.tracks[0]) {
            queue.history.unshift({ ...queue.tracks[0] });
            if (queue.history.length > 10) queue.history.pop();
        }

        queue.tracks.shift();

        if (queue.tracks.length > 0) {
            applyShuffleIfNeeded(queue);
            playNext(guildId);
        } else {
            queue.playing = false;
            queue.isTransitioning = false;
            closeControlPanels(queue, '✅ Очередь закончилась').catch(() => {});
            if (!queue.controlPanels.length) textChannel.send('✅ Очередь закончилась — покидаю канал').catch(() => {});
            setTimeout(() => {
                const q = queues.get(guildId);
                if (q && !q.playing) { q.connection.destroy(); queues.delete(guildId); }
            }, 5000);
        }
    });

    // После ошибки плеер сам уходит в Idle, и очередь двигает обработчик выше.
    // Раньше тут тоже делали shift() + playNext() - из-за этого пропадал соседний трек
    player.on('error', (err) => {
        console.error('Player error:', err.message);
    });

    connection.on('error', (err) => {
        console.error('Voice connection error:', err.message);
    });

    connection.on('stateChange', async (oldState, newState) => {
        if (newState.status !== VoiceConnectionStatus.Disconnected) return;
        try {
            await Promise.race([
                entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
            ]);
        } catch {
            console.error('Voice connection lost, destroying queue for guild', guildId);
            textChannel.send('❌ Потеряно соединение — отключаюсь').catch(() => {});
            destroyQueue(guildId);
        }
    });

    connection.subscribe(player);
    return queue;
}

// ─── Воспроизведение ─────────────────────────────────────────────────────────────────
//
// Трек сначала целиком качается в файл и только потом играет: если YouTube не отдал
// (403 с IP DE), пробуем другие варианты из поиска, а не играем пустой поток 3 секунды.
// YouTube - через yt-tunnel на NL (socks5 1089, как у Telegram-бота) свежим yt-dlp из
// venv FMvideo с клиентом tv_embedded. Нет туннеля - идём напрямую.
//
// Очередь двигает только обработчик Idle (или команды, которые сами ставят isTransitioning);
// каждый playNext получает номер, устаревший (нажали скип, пока трек грузился) молча выходит.

const net = require('net');

const YTDLP = fs.existsSync('/root/FMvideo/venv/bin/yt-dlp') ? '/root/FMvideo/venv/bin/yt-dlp' : 'yt-dlp';
const YT_PROXY_PORT = 1089;
const CACHE_DIR = path.join(os.tmpdir(), 'fm-music');
fs.mkdirSync(CACHE_DIR, { recursive: true });
for (const f of fs.readdirSync(CACHE_DIR)) { try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch {} }

function portUp(port) {
    return new Promise((resolve) => {
        const s = net.connect(port, '127.0.0.1');
        const done = (ok) => { s.destroy(); resolve(ok); };
        s.setTimeout(500, () => done(false));
        s.once('connect', () => done(true));
        s.once('error', () => done(false));
    });
}

async function ytArgs(target) {
    const a = ['--no-warnings', '--quiet', '--cookies', './cookies.txt', '--no-playlist'];
    if (/youtu\.?be|youtube\.com|^ytsearch/.test(target)) {
        a.push('--extractor-args', 'youtube:player_client=tv_embedded');
        if (await portUp(YT_PROXY_PORT)) a.push('--proxy', `socks5://127.0.0.1:${YT_PROXY_PORT}`);
    }
    return a;
}

// Spotify-трек: варианты с YouTube (похожие по длительности), потом SoundCloud
async function searchCandidates(track) {
    const want = track.durationSec || 0;
    const out = [];
    for (const q of [`ytsearch6:${track.spotifySearch}`, `scsearch3:${track.spotifySearch}`]) {
        try {
            const { stdout } = await execFileAsync(YTDLP, [...await ytArgs(q), '--dump-json', '--flat-playlist', q],
                { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });
            for (const line of stdout.trim().split('\n').filter(Boolean)) {
                let d;
                try { d = JSON.parse(line); } catch { continue; }
                const e = parseEntry(d);
                const dur = Math.round(d.duration || 0);
                if (!e) continue;
                if (dur > 20 * 60) continue;                                          // сборники/стримы
                if (want && dur && Math.abs(dur - want) > Math.max(20, want / 10)) continue;
                if (dur && dur < 60 && want > 90) continue;                           // 30-сек превью SoundCloud
                out.push(e.url);
            }
        } catch (err) {
            console.error(`[search] ${q}: ${err.message.split('\n')[0]}`);
        }
        if (out.length >= 3) break;
    }
    return [...new Set(out)].slice(0, 6);
}

async function downloadTrack(track, signal) {
    const urls = track.url ? [track.url] : [];
    if (track.spotifySearch && (!track.url || track.fromSearch)) {
        for (const u of await searchCandidates(track)) if (!urls.includes(u)) urls.push(u);
    }
    if (!urls.length) throw new Error('ничего не нашлось');
    let lastErr = null;
    for (const u of urls) {
        if (signal.aborted) throw new Error('aborted');
        const base = path.join(CACHE_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        try {
            const { stdout } = await execFileAsync(YTDLP, [...await ytArgs(u), '-f', 'bestaudio/best', '--no-part',
                '--max-filesize', '200M', '--match-filter', '!is_live & duration <= 10800',
                '-o', `${base}.%(ext)s`, '--print', 'after_move:filepath', u], { timeout: 240_000, signal });
            const file = stdout.trim().split('\n').pop();
            if (file && fs.existsSync(file) && fs.statSync(file).size > 10_000) {
                if (!track.url) { track.url = u; track.fromSearch = true; }
                return file;
            }
            lastErr = new Error('пустой файл');
        } catch (err) {
            if (signal.aborted) throw err;
            lastErr = err;
            console.error(`[download] ${track.title} <- ${u}: ${(err.stderr || err.message || '').trim().split('\n').pop()}`);
        }
    }
    throw lastErr || new Error('не скачалось');
}

// Загрузка привязана к самому треку: подгрузка следующего не может достаться чужому треку
function ensureLoaded(track) {
    if (track.isTempFile && track.url && fs.existsSync(track.url)) return Promise.resolve(track.url);
    if (track._file && fs.existsSync(track._file)) return Promise.resolve(track._file);
    if (!track._load) {
        const ac = new AbortController();
        track._abort = ac;
        track._load = downloadTrack(track, ac.signal)
            .then((file) => { track._file = file; return file; })
            .catch((err) => { track._load = null; throw err; });
    }
    return track._load;
}

function forgetFile(track) {
    try { track._abort?.abort(); } catch {}
    track._load = null;
    track._abort = null;
    track._file = null;
}

// Файлы, которые больше не нужны ни одной очереди (кроме текущего и следующего трека)
function sweepFiles() {
    const keep = new Set();
    for (const q of queues.values()) {
        for (const t of q.tracks.slice(0, 2)) if (t._file) keep.add(t._file);
        for (const t of q.history.slice(0, 1)) if (t._file) keep.add(t._file); // кнопка "назад"
    }
    for (const f of fs.readdirSync(CACHE_DIR)) {
        const p = path.join(CACHE_DIR, f);
        try {
            if (!keep.has(p) && Date.now() - fs.statSync(p).mtimeMs > 30_000) fs.unlinkSync(p);
        } catch {}
    }
}

// Совместимость со старым кодом: остановка/выход - отменить загрузки и подчистить файлы
function cleanupPrefetch(queue) {
    for (const t of queue.tracks) if (t._load && !t._file) forgetFile(t);
    setTimeout(sweepFiles, 1000);
}

async function playNext(guildId) {
    const queue = queues.get(guildId);
    if (!queue || queue.destroyed) return;
    if (queue.tracks.length === 0) {
        queue.playing = false;
        queue.isTransitioning = false;
        return;
    }

    const token = queue.playToken = (queue.playToken || 0) + 1;
    const track = queue.tracks[0];
    queue.playing = true;
    queue.paused = false;
    queue.isTransitioning = true;

    let file;
    try {
        file = await ensureLoaded(track);
    } catch (err) {
        if (token !== queue.playToken || queue.destroyed) return;   // пока грузили - уже переключили
        console.error(`[play] ${track.title}: ${err.message.split('\n')[0]}`);
        queue.textChannel.send(`⚠️ Не получилось загрузить **${track.title}**, пропускаю`).catch(() => {});
        if (queue.tracks[0] === track) queue.tracks.shift();
        return playNext(guildId);
    }
    if (token !== queue.playToken || queue.destroyed || queue.tracks[0] !== track) return;

    try {
        const resource = createAudioResource(file, { inputType: StreamType.Arbitrary, inlineVolume: true });
        if (track.isTempFile) {
            resource.playStream.once('close', () => { if (!queue.loop) { try { fs.unlinkSync(file); } catch {} } });
        }
        queue.currentResource = resource;
        setVolume(queue);
        queue.player.play(resource);
        queue.isTransitioning = false;
        queue.trackStartedAt = Date.now();
        queue.pausedAt = null;

        // подгрузка следующего - в его собственный файл
        if (queue.tracks[1] && getSetting(guildId, 'prefetch', true)) ensureLoaded(queue.tracks[1]).catch(() => {});
        sweepFiles();

        // Обновляем существующие панели или создаём новую в основном канале
        pruneControlPanels(queue);
        if (queue.controlPanels.length > 0) {
            await updateNowPlayingMsg(queue, queue.guildId);
        } else {
            try {
                const mainPanel = await queue.textChannel.send({
                    embeds: [buildEmbed(queue, queue.guildId)],
                    components: buildComponents(queue),
                });
                queue.controlPanels.push(mainPanel);
            } catch {}
        }
    } catch (err) {
        console.error('playNext error:', err);
        if (token !== queue.playToken) return;
        queue.textChannel.send(`❌ Не удалось воспроизвести: ${safeErr(err)}`).catch(() => {});
        if (queue.tracks[0] === track) queue.tracks.shift();
        forgetFile(track);
        return playNext(guildId);
    }
}

// ─── Утилиты yt-dlp ───────────────────────────────────────────────────────────

function parseDuration(seconds) {
    if (!seconds) return '?:??';
    const m = Math.floor(seconds / 60);
    const s = String(Math.floor(seconds % 60)).padStart(2, '0');
    return `${m}:${s}`;
}

function parseEntry(d) {
    const url =
        d.webpage_url ||
        (d.url && d.url.startsWith('http') ? d.url : null) ||
        (d.id ? `https://www.youtube.com/watch?v=${d.id}` : null);
    if (!url || !isAllowedUrl(url)) return null;
    return {
        title:  d.title || d.fulltitle || d.alt_title || 'Unknown',
        author: d.uploader || d.channel || d.creator || d.artist || 'Unknown',
        url,
        duration: parseDuration(d.duration),
        durationSec: Math.round(d.duration || 0),
        spotifySearch: null,
        requestedBy: null,
        thumbnail: d.thumbnail ?? null,
        spotifyUrl: null,
        isTempFile: false,
    };
}

const YTDLP_BASE = ['--no-warnings', '--quiet', '--cookies', './cookies.txt'];

function classifyQuery(query) {
    if (/open\.spotify\.com\/(track|album|playlist)/.test(query)) return 'spotify';
    if (/youtu\.?be|youtube\.com/.test(query)) return 'youtube';
    if (/soundcloud\.com/.test(query)) return 'soundcloud';
    if (/tiktok\.com\/music\//.test(query)) return 'tiktok_music';
    if (/tiktok\.com/.test(query)) return 'tiktok';
    if (/t\.me\//.test(query)) return 'telegram';
    return 'search';
}

// Хост из списка, иначе это поиск. Раньше «youtube.com» где угодно в тексте отправляло строку
// в yt-dlp как есть: «--опция ...» читалась как опция, а http://127.0.0.1:порт/?youtube.com - запрос
// к локальным службам сервера
const ALLOWED_HOSTS = ['youtube.com', 'youtu.be', 'soundcloud.com', 'tiktok.com', 't.me', 'spotify.com'];
function isAllowedUrl(q) {
    // «https://youtube.com\\@127.0.0.1:8081/» для Node - youtube.com, а для yt-dlp - 127.0.0.1
    if (/[\\\s\x00-\x1f]/.test(q.trim())) return false;
    try {
        const u = new URL(q.trim());
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
        if (u.username || u.password) return false;
        const h = u.hostname.toLowerCase();
        return ALLOWED_HOSTS.some((d) => h === d || h.endsWith('.' + d));
    } catch { return false; }
}

async function fetchTracks(query, guildId = null) {
    query = query.trim();
    let type = classifyQuery(query);
    if (type !== 'search' && !isAllowedUrl(query)) type = 'search';
    if (type !== 'search') query = new URL(query).href;  // yt-dlp получает ровно то, что проверили

    if (type === 'spotify') {
        const parsed = parseSpotifyUrl(query);
        if (!parsed) throw new Error('Invalid Spotify URL');
        if (parsed.type === 'track')    return fetchSpotifyTrack(parsed.id);
        if (parsed.type === 'album')    return fetchSpotifyAlbum(parsed.id);
        if (parsed.type === 'playlist') return fetchSpotifyPlaylist(parsed.id, guildId);
    }

    if (type === 'tiktok_music') {
        throw new Error('Ссылки на звук TikTok не поддерживаются — скопируй ссылку на видео');
    }

    if (type === 'tiktok') {
        const { stdout } = await execFileAsync('yt-dlp', [
            ...YTDLP_BASE, '--dump-json', '--no-playlist', '-f', 'bestaudio/best', query,
        ], { timeout: 90_000, maxBuffer: 20 * 1024 * 1024 });
        const entry = parseEntry(JSON.parse(stdout.trim()));
        return entry ? [entry] : [];
    }

    if (type === 'telegram') {
        return fetchTelegramMedia(query);
    }

    if (type === 'search') {
        const { stdout } = await execFileAsync('yt-dlp', [
            ...YTDLP_BASE, '--dump-json', '--flat-playlist', `ytsearch5:${query}`,
        ], { timeout: 90_000, maxBuffer: 20 * 1024 * 1024 });
        return stdout.trim().split('\n').filter(Boolean)
            .map((l) => parseEntry(JSON.parse(l))).filter(Boolean);
    }

    if (/[?&]list=RD/.test(query)) {
        const cleanUrl = query.replace(/[?&]list=[^&]+/, '').replace(/[?&]si=[^&]+/, '');
        const { stdout } = await execFileAsync('yt-dlp', [
            ...YTDLP_BASE, '--dump-json', '--no-playlist', cleanUrl,
        ], { timeout: 90_000, maxBuffer: 20 * 1024 * 1024 });
        const entry = parseEntry(JSON.parse(stdout.trim()));
        return entry ? [entry] : [];
    }

    const isPlaylist = /[?&]list=/.test(query) || /soundcloud\.com\/.*\/sets\//.test(query);
    if (isPlaylist) {
        const { stdout } = await execFileAsync('yt-dlp', [
            ...YTDLP_BASE, '--dump-json', '--playlist-items', '1-50', query,
        ], { timeout: 180_000, maxBuffer: 100 * 1024 * 1024 });
        return stdout.trim().split('\n').filter(Boolean).map((l) => {
            try { return parseEntry(JSON.parse(l)); } catch { return null; }
        }).filter(Boolean);
    }

    const { stdout } = await execFileAsync('yt-dlp', [
        ...YTDLP_BASE, '--dump-json', '--no-playlist', query,
    ], { timeout: 90_000, maxBuffer: 20 * 1024 * 1024 });
    const entry = parseEntry(JSON.parse(stdout.trim()));
    return entry ? [entry] : [];
}

async function searchTracks(query) {
    const { stdout } = await execFileAsync('yt-dlp', [
        ...YTDLP_BASE, '--dump-json', '--flat-playlist', `ytsearch5:${query}`,
    ], { timeout: 90_000, maxBuffer: 20 * 1024 * 1024 });
    return stdout.trim().split('\n').filter(Boolean)
        .map((l) => parseEntry(JSON.parse(l))).filter(Boolean);
}

// ─── Slash команды ───────────────────────────────────────────────────────────

const commands = [
    new SlashCommandBuilder()
        .setName('play')
        .setDescription('Play a track or playlist (YouTube / SoundCloud / Spotify)')
        .addStringOption((opt) =>
            opt.setName('query').setDescription('Track name, artist, or URL').setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('search')
        .setDescription('Search YouTube and pick from results')
        .addStringOption((opt) =>
            opt.setName('query').setDescription('Search query').setRequired(true)
        ),
    new SlashCommandBuilder()
        .setName('menu')
        .setDescription('Открыть панель управления в текущем канале'),
    new SlashCommandBuilder()
        .setName('online')
        .setDescription('Бот зайдёт в канал и не будет выходить пока не скажешь /offline'),
    new SlashCommandBuilder()
        .setName('offline')
        .setDescription('Бот выйдет из голосового канала'),
    new SlashCommandBuilder()
        .setName('settings')
        .setDescription('Настройки бота для этого сервера')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((sub) =>
            sub.setName('prefetch')
               .setDescription('Предзагрузка следующего трека пока играет текущий')
               .addBooleanOption((opt) =>
                   opt.setName('enabled')
                      .setDescription('Включить или выключить')
                      .setRequired(true)
               )
        )
        .addSubcommand((sub) =>
            sub.setName('spotify_account')
               .setDescription('Какой Spotify-аккаунт использовать для приватных плейлистов на этом сервере')
               .addIntegerOption((opt) =>
                   opt.setName('номер')
                      .setDescription('Номер аккаунта из .env (SPOTIFY_SP_DC_N), 0 — не использовать')
                      .setRequired(true)
                      .setMinValue(0)
                      .setMaxValue(9)
               )
        )
        .addSubcommand((sub) =>
            sub.setName('progress_bar')
               .setDescription('Показывать прогресс-бар трека в панели управления')
               .addStringOption((opt) =>
                   opt.setName('режим')
                      .setDescription('Как показывать прогресс')
                      .setRequired(true)
                      .addChoices(
                          { name: 'Выключено', value: 'off' },
                          { name: 'Текстом', value: 'text' },
                          { name: 'Картинкой', value: 'image' },
                      )
               )
        ),
    new SlashCommandBuilder()
        .setName('help')
        .setDescription('Список команд и как пользоваться ботом'),
].map((cmd) => cmd.toJSON());

// ─── Запуск ────────────────────────────────────────────────────────────────────

client.once('clientReady', async () => {
    console.log(`Logged in as ${client.user.tag}, guilds: ${client.guilds.cache.size}`);
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Slash commands registered globally');
    } catch (err) {
        console.error('Failed to register commands:', err);
    }
});

// ─── Вспомогательные функции ──────────────────────────────────────────────────────────────────

// Бот в канале - управлять им может только тот, кто сидит в этом же канале
function inBotVoice(interaction) {
    const botCh = interaction.guild?.members?.me?.voice?.channelId;
    return !botCh || interaction.member?.voice?.channelId === botCh;
}
const NOT_IN_VOICE = { content: 'Управлять музыкой может только тот, кто в голосовом канале с ботом', ephemeral: true };

function requireVoice(interaction) {
    const channel = interaction.member?.voice?.channel;
    if (!channel) {
        interaction.reply({ content: 'Ты должен быть в голосовом канале', ephemeral: true }).catch(() => {});
        return null;
    }
    return channel;
}

async function ensureQueue(interaction, voiceChannel) {
    let queue = queues.get(interaction.guild.id);
    if (!queue) {
        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: interaction.guild.id,
            adapterCreator: interaction.guild.voiceAdapterCreator,
            selfDeaf: true,
        });
        try {
            await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
        } catch {
            connection.destroy();
            await interaction.followUp('Не удалось подключиться к голосовому каналу')
            return null;
        }
        queue = createQueue(interaction.guild.id, connection, interaction.channel);
    }
    return queue;
}

// ─── Help-центр ───────────────────────────────────────────────────────────────

const HELP_CATEGORIES = {
    track: {
        label: 'Трек',
        emoji: '🎵',
        title: 'Управление треком',
        text:
            '`/play` — воспроизвести трек или плейлист (ссылка или название)\n' +
            '`/search` — поиск на YouTube с выбором из 5 результатов\n\n' +
            '**Кнопки в панели:**\n' +
            '⏮ / ⏭ — предыдущий / следующий трек\n' +
            '⏸ / ▶️ — пауза / возобновить\n' +
            '🔁 — перезапустить текущий трек\n' +
            '💾 — прислать ссылки на трек в ЛС',
    },
    queue: {
        label: 'Очередь',
        emoji: '📋',
        title: 'Очередь и порядок',
        text:
            '📋 — показать текущую очередь\n' +
            '♾️ — повтор текущего трека\n' +
            '🔀 — случайный порядок\n' +
            'История хранит последние 10 треков — доступна через ⏮\n\n' +
            'В `/play` можно вставить сразу несколько ссылок, каждую с новой строки.',
    },
    spotify: {
        label: 'Spotify',
        emoji: '🟢',
        title: 'Поддержка Spotify',
        text:
            'Треки, альбомы и плейлисты (публичные и приватные с `SPOTIFY_SP_DC`).\n' +
            'Можно вставлять целиком код `<iframe>` — бот сам вытащит ссылку.\n\n' +
            '`/settings spotify_account` — выбрать какой Spotify-аккаунт использовать\n' +
            'на этом сервере для приватных плейлистов.',
    },
    settings: {
        label: 'Настройки',
        emoji: '⚙️',
        title: 'Настройки бота',
        text:
            '`/settings prefetch` — предзагрузка следующего трека в фоне\n' +
            '`/settings progress_bar` — прогресс-бар трека (текстом/картинкой/выкл)\n' +
            '`/settings spotify_account` — Spotify-аккаунт для приватных плейлистов\n\n' +
            '`/online` — бот остаётся в канале даже когда очередь пуста\n' +
            '`/offline` — бот выходит из голосового канала\n' +
            '`/menu` — открыть панель управления в текущем канале',
    },
};

function buildHelpEmbed(categoryKey) {
    const cat = HELP_CATEGORIES[categoryKey];
    if (!cat) {
        return new EmbedBuilder()
            .setColor(0x1DB954)
            .setTitle('Помощь')
            .setDescription('Выбери категорию ниже, чтобы узнать подробности.')
            .addFields(
                Object.values(HELP_CATEGORIES).map((c) => ({ name: `${c.emoji} ${c.label}`, value: '\u200b', inline: true }))
            );
    }
    return new EmbedBuilder()
        .setColor(0x1DB954)
        .setTitle(`${cat.emoji} ${cat.title}`)
        .setDescription(cat.text);
}

function buildHelpSelectRow() {
    const menu = new StringSelectMenuBuilder()
        .setCustomId('help_select')
        .setPlaceholder('Выбери категорию')
        .addOptions(
            Object.entries(HELP_CATEGORIES).map(([key, c]) => ({
                label: c.label,
                value: key,
                emoji: c.emoji,
            }))
        );
    return new ActionRowBuilder().addComponents(menu);
}

// ─── Обработка команд ─────────────────────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
    if (!interaction.guild) {  // в личке нет сервера - раньше interaction.guild.id ронял весь процесс
        if (interaction.isRepliable()) interaction.reply({ content: 'Я работаю только на серверах', ephemeral: true }).catch(() => {});
        return;
    }

    // ── /play ──────────────────────────────────────────────────────────────────
    if (interaction.isChatInputCommand() && interaction.commandName === 'play') {
        const voiceChannel = requireVoice(interaction);
        if (!voiceChannel) return;
        if (!inBotVoice(interaction)) return interaction.reply(NOT_IN_VOICE);
        const query = interaction.options.getString('query');
        await interaction.deferReply();

        try {
            // Извлекаем URL даже из HTML-кода (например вставленного <iframe> с embed-ссылкой)
            // и конвертируем embed-ссылки Spotify в обычные
            const urlMatches = query.match(/https?:\/\/[^\s"'<>]+/g) || [];
            const lines = (urlMatches.length > 0 ? urlMatches : query.split(/\n+/).map((l) => l.trim()).filter((l) => l.startsWith('http')))
                .map((u) => u.replace('open.spotify.com/embed/', 'open.spotify.com/'));
            const queryList = lines.length > 0 ? lines.slice(0, 5) : [query.trim()];  // не больше 5 ссылок за раз

            const allTracks = [];
            const errors = [];

            for (const q of queryList) {
                try {
                    const tracks = await fetchTracks(q, interaction.guild.id);
                    tracks.forEach((t) => { t.requestedBy = `<@${interaction.user.id}>`; });
                    allTracks.push(...tracks);
                } catch (err) {
                    errors.push(`❌ \`${q.slice(0, 60).replace(/`/g, '')}\`: ${safeErr(err)}`);
                }
            }

            if (allTracks.length > 100) allTracks.length = 100;  // не больше 100 треков за раз
            if (!allTracks.length) {
                return interaction.followUp(errors.length ? errors.join('\n') : '❌ Ничего не найдено');
            }

            const queue = await ensureQueue(interaction, voiceChannel);
            if (!queue) return;

            const wasEmpty = queue.tracks.length === 0;
            queue.tracks.push(...allTracks);

            if (wasEmpty && !queue.playing) playNext(interaction.guild.id);

            let reply = allTracks.length === 1
                ? `${wasEmpty ? '🎵 Сейчас играет' : '➕ Добавлено в очередь'}: **${allTracks[0].title}** — **${allTracks[0].author}** [${allTracks[0].duration}]`
                : `➕ Добавлено **${allTracks.length} треков** в очередь`;

            if (errors.length) reply += `\n\n${errors.join('\n')}`;
            await interaction.followUp(reply);
        } catch (err) {
            console.error(err);
            await interaction.followUp(`❌ Не удалось воспроизвести: ${safeErr(err)}`);
        }
    }

    // ── /search ────────────────────────────────────────────────────────────────
    else if (interaction.isChatInputCommand() && interaction.commandName === 'search') {
        const voiceChannel = requireVoice(interaction);
        if (!voiceChannel) return;
        const query = interaction.options.getString('query');
        await interaction.deferReply();

        try {
            const tracks = await searchTracks(query);
            if (!tracks.length) return interaction.followUp('❌ Ничего не найдено');

            const menu = new StringSelectMenuBuilder()
                .setCustomId('search_pick')
                .setPlaceholder('Выбери трек..')
                .addOptions(tracks.map((t, i) => ({
                    label: t.title.slice(0, 100),
                    description: `${t.author} [${t.duration}]`.slice(0, 100),
                    value: String(i),
                })));

            const row = new ActionRowBuilder().addComponents(menu);
            const msg = await interaction.followUp({
                content: `🔍 Результаты поиска по **${query}**:`,
                components: [row],
            });

            const collector = msg.createMessageComponentCollector({
                filter: (i) => i.user.id === interaction.user.id,
                time: 30000,
                max: 1,
            });

            collector.on('collect', async (i) => {
                const track = tracks[parseInt(i.values[0])];
                track.requestedBy = `<@${i.user.id}>`;
                await i.deferUpdate();
                try {
                    const queue = await ensureQueue(interaction, voiceChannel);
                    if (!queue) return;
                    const wasEmpty = queue.tracks.length === 0;
                    queue.tracks.push(track);
                    if (wasEmpty && !queue.playing) playNext(interaction.guild.id);
                    await msg.edit({
                        content: wasEmpty
                            ? `🎵 Сейчас играет: **${track.title}** — **${track.author}**`
                            : `➕ Добавлено в очередь: **${track.title}** — **${track.author}**`,
                        components: [],
                    });
                } catch (err) {
                    await msg.edit({ content: `❌ Ошибка: ${safeErr(err)}`, components: [] });
                }
            });

            collector.on('end', (_, reason) => {
                if (reason === 'time') {
                    msg.edit({ content: '⏰ Время поиска истекло', components: [] }).catch(() => {});
                }
            });
        } catch (err) {
            console.error(err);
            await interaction.followUp(`❌ Ошибка поиска: ${safeErr(err)}`);
        }
    }

    // ── /menu ────────────────────────────────────────────────────────────────
    else if (interaction.isChatInputCommand() && interaction.commandName === 'menu') {
        const queue = getQueue(interaction.guild.id);
        if (!queue?.playing) {
            return interaction.reply({ content: 'Ничего не играет', ephemeral: true });
        }
        const panel = await interaction.reply({
            embeds: [buildEmbed(queue, queue.guildId)],
            components: buildComponents(queue),
            fetchReply: true,
        });
        queue.controlPanels = queue.controlPanels || [];
        queue.controlPanels.push(panel);
    }

    // ── /online ───────────────────────────────────────────────────────────────
    else if (interaction.isChatInputCommand() && interaction.commandName === 'online') {
        const voiceChannel = requireVoice(interaction);
        if (!voiceChannel) return;
        await interaction.deferReply({ ephemeral: true });
        let queue = getQueue(interaction.guild.id);
        if (!queue) {
            queue = await ensureQueue(interaction, voiceChannel);
            if (!queue) return;
        }
        queue.stayInVoice = true;
        await interaction.followUp({ content: '✅ Буду в канале пока не скажешь /offline', ephemeral: true });
    }

    // ── /offline ──────────────────────────────────────────────────────────────
    else if (interaction.isChatInputCommand() && interaction.commandName === 'offline') {
        const queue = getQueue(interaction.guild.id);
        if (!queue) return interaction.reply({ content: 'Меня нет в канале', ephemeral: true });
        if (!inBotVoice(interaction)) return interaction.reply(NOT_IN_VOICE);
        destroyQueue(interaction.guild.id);
        await interaction.reply({ content: '👋 Вышел из канала', ephemeral: true });
    }

    // ── /settings ─────────────────────────────────────────────────────────────
    else if (interaction.isChatInputCommand() && interaction.commandName === 'settings') {
        // настройки (в т.ч. чей Spotify-аккаунт) - только тем, кто управляет сервером
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({ content: 'Настройки меняет только тот, кто управляет сервером', ephemeral: true });
        }
        const sub = interaction.options.getSubcommand();
        if (sub === 'prefetch') {
            const enabled = interaction.options.getBoolean('enabled');
            saveSetting(interaction.guild.id, 'prefetch', enabled);
            await interaction.reply({
                content: `Предзагрузка треков: **${enabled ? '✅ включена' : '❌ выключена'}**`,
                ephemeral: true,
            });
        } else if (sub === 'spotify_account') {
            const num = interaction.options.getInteger('номер');
            if (num === 0) {
                saveSetting(interaction.guild.id, 'spotifyAccount', null);
                await interaction.reply({ content: 'Приватные плейлисты Spotify отключены для этого сервера', ephemeral: true });
            } else if (!process.env[`SPOTIFY_SP_DC_${num}`]) {
                await interaction.reply({ content: `SPOTIFY_SP_DC_${num} не найден в .env`, ephemeral: true });
            } else {
                saveSetting(interaction.guild.id, 'spotifyAccount', num);
                await interaction.reply({ content: `Для этого сервера теперь используется Spotify-аккаунт #${num}`, ephemeral: true });
            }
        } else if (sub === 'progress_bar') {
            const mode = interaction.options.getString('режим');
            if (mode === 'image' && !tryLoadCanvas()) {
                return interaction.reply({
                    content: '❌ Пакет `canvas` не установлен на сервере. Выполни `npm install canvas` или выбери режим "Текстом".',
                    ephemeral: true,
                });
            }
            saveSetting(interaction.guild.id, 'progressBar', mode);
            const labels = { off: 'выключен', text: 'текстовый', image: 'картинкой' };
            await interaction.reply({ content: `Прогресс-бар: **${labels[mode]}**`, ephemeral: true });

            // Обновляем панель сразу, не дожидаясь следующего трека
            const activeQueue = getQueue(interaction.guild.id);
            if (activeQueue?.playing) {
                updateNowPlayingMsg(activeQueue, interaction.guild.id).catch(() => {});
            }
        }
    }

    // ── /help ─────────────────────────────────────────────────────────────────
    else if (interaction.isChatInputCommand() && interaction.commandName === 'help') {
        await interaction.reply({
            embeds: [buildHelpEmbed(null)],
            components: [buildHelpSelectRow()],
        });
    }

    // ── Выбор категории в /help ──────────────────────────────────────────────────
    else if (interaction.isStringSelectMenu() && interaction.customId === 'help_select') {
        const categoryKey = interaction.values[0];
        await interaction.update({
            embeds: [buildHelpEmbed(categoryKey)],
            components: [buildHelpSelectRow()],
        });
    }

    // ── Кнопки ────────────────────────────────────────────────────────────────
    else if (interaction.isButton()) {
        const queue = getQueue(interaction.guild?.id);
        const id = interaction.customId;
        if (id !== 'btn_queue' && !inBotVoice(interaction)) return interaction.reply(NOT_IN_VOICE);

        // Очередь можно показать даже без активного воспроизведения
        if (id === 'btn_queue') {
            if (!queue || queue.tracks.length === 0) {
                return interaction.reply({ content: '📋 Очередь пуста', ephemeral: true });
            }
            const [current, ...rest] = queue.tracks;
            const list = rest.length
                ? rest.slice(0, 10).map((t, i) => `${i + 1}. **${t.title}** — ${t.author} [${t.duration}]`).join('\n')
                : 'Больше треков нет';
            return interaction.reply({
                content: `🎵 **Сейчас играет:** ${current.title} — ${current.author} [${current.duration}]\n\n**В очереди:**\n${list}`,
                ephemeral: true,
            });
        }

        if (!queue?.playing) {
            return interaction.reply({ content: 'Ничего не играет', ephemeral: true });
        }

        switch (id) {

            case 'btn_prev': {
                if (!queue.history.length) {
                    return interaction.reply({ content: 'История треков пуста', ephemeral: true });
                }
                const prev = queue.history.shift();
                prev.requestedBy = prev.requestedBy ?? `<@${interaction.user.id}>`;
                queue.tracks.unshift(prev);
                queue.isTransitioning = true;
                killCurrent(queue);
                queue.player.stop(true);
                await interaction.deferUpdate();
                playNext(interaction.guild.id);
                break;
            }

            case 'btn_pause': {
                queue.player.pause();
                queue.paused = true;
                queue.pausedAt = Date.now();
                await updateNowPlayingMsg(queue, queue.guildId);
                await interaction.deferUpdate();
                break;
            }

            case 'btn_resume': {
                queue.player.unpause();
                queue.paused = false;
                if (queue.pausedAt && queue.trackStartedAt) {
                    queue.trackStartedAt += Date.now() - queue.pausedAt; // сдвигаем старт на время паузы
                }
                queue.pausedAt = null;
                await updateNowPlayingMsg(queue, queue.guildId);
                await interaction.deferUpdate();
                break;
            }

            case 'btn_skip': {
                queue.isTransitioning = true;
                // Сохраняем в историю перед скипом
                if (queue.tracks[0]) {
                    queue.history.unshift({ ...queue.tracks[0] });
                    if (queue.history.length > 10) queue.history.pop();
                }
                killCurrent(queue);
                queue.player.stop(true);
                await interaction.deferUpdate();
                queue.tracks.shift();
                if (queue.tracks.length > 0) {
                    applyShuffleIfNeeded(queue);
                    playNext(interaction.guild.id);
                } else {
                    queue.playing = false;
                    queue.isTransitioning = false;
                    closeControlPanels(queue, '✅ Очередь закончилась').catch(() => {});
                }
                break;
            }

            case 'btn_mute': {
                queue.muted = !queue.muted;
                setVolume(queue);
                await updateNowPlayingMsg(queue, queue.guildId);
                await interaction.deferUpdate();
                break;
            }

            case 'btn_vol_down': {
                queue.volume = Math.max(0, Math.round((queue.volume - 0.1) * 10) / 10);
                queue.muted = queue.volume === 0;
                setVolume(queue);
                saveSetting(interaction.guild.id, 'volume', queue.volume);
                await updateNowPlayingMsg(queue, queue.guildId);
                await interaction.deferUpdate();
                break;
            }

            case 'btn_vol_up': {
                queue.volume = Math.min(1, Math.round((queue.volume + 0.1) * 10) / 10);
                queue.muted = false;
                setVolume(queue);
                saveSetting(interaction.guild.id, 'volume', queue.volume);
                await updateNowPlayingMsg(queue, queue.guildId);
                await interaction.deferUpdate();
                break;
            }

            case 'btn_save': {
                const track = queue.tracks[0];
                try {
                    const lines = [`💾 **${track.title}** — **${track.author}** [${track.duration}]`];
                    if (track.url) {
                        let label = 'Ссылка';
                        if (/youtu\.?be|youtube\.com/.test(track.url)) label = 'YouTube';
                        else if (/soundcloud\.com/.test(track.url)) label = 'SoundCloud';
                        else if (/tiktok\.com/.test(track.url)) label = 'TikTok';
                        else if (track.url.startsWith('/tmp') || track.url.startsWith('/var/folders')) label = 'Telegram';
                        lines.push(`${label}: ${track.url.startsWith('/') ? track.tgUrl ?? '(локальный файл)' : track.url}`);
                    }
                    if (track.spotifyUrl) lines.push(`Spotify: ${track.spotifyUrl}`);
                    await interaction.user.send(lines.join('\n'));
                    await interaction.reply({ content: '💾 Отправлено в личные сообщения', ephemeral: true });
                } catch {
                    await interaction.reply({ content: 'Не удалось отправить ЛС. Разреши личные сообщения от участников сервера', ephemeral: true });
                }
                break;
            }

            case 'btn_loop': {
                queue.loop = !queue.loop;
                await updateNowPlayingMsg(queue, queue.guildId);
                await interaction.deferUpdate();
                break;
            }

            case 'btn_replay': {
                queue.isTransitioning = true;
                killCurrent(queue);
                queue.player.stop(true);
                await interaction.deferUpdate();
                playNext(interaction.guild.id); // Трек остаётся на месте — запускаем заново
                break;
            }

            case 'btn_stop': {
                if (queue.stayInVoice) {
                    // /online активен — просто останавливаем музыку, из канала не выходим
                    queue.isTransitioning = true;
                    killCurrent(queue);
                    cleanupPrefetch(queue);
                    queue.tracks = [];
                    queue.player.stop(true);
                    queue.playing = false;
                    queue.isTransitioning = false;
                    await closeControlPanels(queue, `⏹ Остановлено — <@${interaction.user.id}> (жду новых треков)`);
                } else {
                    destroyQueue(interaction.guild.id, `<@${interaction.user.id}>`);
                }
                await interaction.deferUpdate();
                break;
            }

            case 'btn_shuffle': {
                queue.shuffle = !queue.shuffle;
                await updateNowPlayingMsg(queue, queue.guildId);
                await interaction.deferUpdate();
                break;
            }

            default:
                await interaction.deferUpdate();
        }
    }
});

// ─── Авторизация ────────────────────────────────────────────────────────────────────

// ─── Таймер прогресс-бара ───────────────────────────────────────────────────
// Обновляет панели раз в 15 сек только там, где прогресс-бар включён —
// чтобы не грузить API Discord запросами там, где это не нужно
setInterval(() => {
    for (const queue of queues.values()) {
        if (!queue.playing || queue.paused || !queue.controlPanels.length) continue;
        const mode = getSetting(queue.guildId, 'progressBar', 'off');
        if (mode === 'off') continue;
        updateNowPlayingMsg(queue, queue.guildId).catch(() => {});
    }
}, 15_000);

client.login(process.env.TOKEN);
