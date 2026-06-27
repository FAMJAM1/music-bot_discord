# FM Music Bot

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)
![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)
![yt-dlp](https://img.shields.io/badge/yt--dlp-latest-FF0000?logo=youtube&logoColor=white)
![Spotify](https://img.shields.io/badge/Spotify-API-1DB954?logo=spotify&logoColor=white)
![SoundCloud](https://img.shields.io/badge/SoundCloud-supported-FF5500?logo=soundcloud&logoColor=white)
![TikTok](https://img.shields.io/badge/TikTok-supported-000000?logo=tiktok&logoColor=white)

Discord музыкальный бот с поддержкой YouTube, SoundCloud, Spotify и TikTok

![Now Playing](preview.png)

---

## Возможности

![YouTube](https://img.shields.io/badge/YouTube-треки%20и%20плейлисты-FF0000?logo=youtube&logoColor=white)
![SoundCloud](https://img.shields.io/badge/SoundCloud-треки%20и%20сеты-FF5500?logo=soundcloud&logoColor=white)
![Spotify](https://img.shields.io/badge/Spotify-треки%20и%20альбомы-1DB954?logo=spotify&logoColor=white)
![TikTok](https://img.shields.io/badge/TikTok-аудио-000000?logo=tiktok&logoColor=white)

- Плейлисты до 50 треков, YouTube Mix
- Несколько ссылок за один `/play` — каждая на новой строке
- Управление через кнопки без slash-команд
- Очередь с историей треков
- Loop — повтор текущего трека
- Shuffle — случайный порядок
- Громкость сохраняется между сессиями
- Сохранить трек — отправляет ссылки в ЛС
- Обложки треков из YouTube, Spotify и TikTok

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
| 🔀 | Рандом |

---

## Команды

| Команда | Описание |
|---------|----------|
| `/play [запрос или ссылка]` | Воспроизвести трек или плейлист |
| `/play [ссылка1\nссылка2]` | Несколько ссылок сразу |
| `/search [запрос]` | Поиск на YouTube с выбором из 5 результатов |

---

## Стек

![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)
![discord.js](https://img.shields.io/badge/discord.js-5865F2?logo=discord&logoColor=white)
![FFmpeg](https://img.shields.io/badge/FFmpeg-007808?logo=ffmpeg&logoColor=white)
![Spotify](https://img.shields.io/badge/Spotify%20Web%20API-1DB954?logo=spotify&logoColor=white)
