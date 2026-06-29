# FM Music Bot

![Node.js](https://img.shields.io/badge/Node.js-v18+-339933?logo=node.js&logoColor=white)
![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)
![yt-dlp](https://img.shields.io/badge/yt--dlp-latest-FF0000?logo=youtube&logoColor=white)
![Spotify](https://img.shields.io/badge/Spotify-API-1DB954?logo=spotify&logoColor=white)
![SoundCloud](https://img.shields.io/badge/SoundCloud-supported-FF5500?logo=soundcloud&logoColor=white)
![TikTok](https://img.shields.io/badge/TikTok-supported-000000?logo=tiktok&logoColor=white)
![Telegram](https://img.shields.io/badge/Telegram-supported-2CA5E0?logo=telegram&logoColor=white)

Discord музыкальный бот с поддержкой YouTube, SoundCloud, Spotify, TikTok и Telegram

![Now Playing](preview.png)

---

## Возможности

![YouTube](https://img.shields.io/badge/YouTube-треки%20и%20плейлисты-FF0000?logo=youtube&logoColor=white)
![SoundCloud](https://img.shields.io/badge/SoundCloud-треки%20и%20сеты-FF5500?logo=soundcloud&logoColor=white)
![Spotify](https://img.shields.io/badge/Spotify-треки%20и%20альбомы-1DB954?logo=spotify&logoColor=white)
![TikTok](https://img.shields.io/badge/TikTok-аудио-000000?logo=tiktok&logoColor=white)
![Telegram](https://img.shields.io/badge/Telegram-аудио%20из%20постов-2CA5E0?logo=telegram&logoColor=white)

- Плейлисты до 50 треков, YouTube Mix
- Несколько ссылок за один `/play` — каждая на новой строке
- Управление через кнопки без slash-команд
- Очередь с историей треков (до 10)
- Предзагрузка следующего трека в фоне
- Повтор текущего трека
- Случайный порядок
- Громкость сохраняется между сессиями
- Сохранить трек — отправляет ссылки в ЛС
- Обложки треков
- Режим онлайн — бот остаётся в канале после окончания очереди

---

## Установка

### Требования

- [Node.js](https://nodejs.org/) v18+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [FFmpeg](https://ffmpeg.org/)

```bash
# Ubuntu / Debian
sudo apt install ffmpeg
pip3 install yt-dlp
```

### 1. Клонировать репозиторий

```bash
git clone https://github.com/FAMJAM1/music-bot_discord
cd music-bot_discord
npm install
```

### 2. Настроить .env

Создай файл `.env` в папке с ботом:

```env
TOKEN=твой_discord_bot_токен
SPOTIFY_CLIENT_ID=твой_spotify_client_id
SPOTIFY_CLIENT_SECRET=твой_spotify_client_secret
SPOTIFY_REFRESH_TOKEN=получается_через_spotify-auth.js
TG_API_ID=твой_telegram_api_id
TG_API_HASH=твой_telegram_api_hash
TG_SESSION=получается_через_tg-auth.js
```

- Токен бота — [Discord Developer Portal](https://discord.com/developers/applications)
- Spotify credentials — [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
- Telegram API — [my.telegram.org](https://my.telegram.org)

### 3. Авторизация Spotify

```bash
node spotify-auth.js
```

### 4. Авторизация Telegram

```bash
node tg-auth.js
```

### 5. Cookies (опционально)

Для обхода ограничений YouTube положи файл `cookies.txt` в папку с ботом.
Экспортировать можно через расширение [Get cookies.txt](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc) в Chrome.

### 6. Запустить

```bash
node index.js
```

### Автозапуск через systemctl (Linux)

```bash
sudo nano /etc/systemd/system/music-bot.service
```

```ini
[Unit]
Description=Discord Music Bot
After=network.target

[Service]
User=root
WorkingDirectory=/root/FMmusic
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable music-bot
sudo systemctl start music-bot
```

---

## Управление

| Кнопка | Действие |
|--------|----------|
| ⏮ | Предыдущий трек |
| ⏸ / ▶️ | Пауза / Возобновить |
| ⏭ | Следующий трек |
| 🔇 | Мут |
| 🔉 / 🔊 | Громкость |
| 📋 | Показать очередь |
| 💾 | Сохранить трек в ЛС |
| ♾️ | Повтор |
| 🔁 | Перезапустить трек |
| ⏹ | Стоп |
| 🔀 | Случайный порядок |

---

## Команды

| Команда | Описание |
|---------|----------|
| `/play [запрос или ссылка]` | Воспроизвести трек или плейлист |
| `/search [запрос]` | Поиск на YouTube с выбором из 5 результатов |
| `/online` | Бот заходит в канал и не выходит пока не скажешь `/offline` |
| `/offline` | Бот выходит из голосового канала |
| `/settings prefetch` | Включить/выключить предзагрузку треков |

---

## Стек

![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)
![discord.js](https://img.shields.io/badge/discord.js-5865F2?logo=discord&logoColor=white)
![FFmpeg](https://img.shields.io/badge/FFmpeg-007808?logo=ffmpeg&logoColor=white)
![Spotify](https://img.shields.io/badge/Spotify%20Web%20API-1DB954?logo=spotify&logoColor=white)
![GramJS](https://img.shields.io/badge/GramJS-2CA5E0?logo=telegram&logoColor=white)
