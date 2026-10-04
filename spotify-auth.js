// Запусти один раз: node spotify-auth.js
// Открой ссылку в браузере, авторизуйся — refresh token запишется в .env автоматически

require('dotenv').config();
const http = require('http');
const https = require('https');
const fs = require('fs');

const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI  = 'http://127.0.0.1:8888/callback';
const SCOPES        = 'playlist-read-private playlist-read-collaborative user-read-email';

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('Нет SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET в .env');
    process.exit(1);
}

const authUrl =
    'https://accounts.spotify.com/authorize' +
    `?client_id=${CLIENT_ID}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(SCOPES)}`;

console.log('\nОткрой эту ссылку в браузере:\n');
console.log(authUrl);
console.log('\nЖду авторизации на порту 8888...\n');

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost:8888');
    if (url.pathname !== '/callback') return;

    const code  = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error || !code) {
        res.end(`Ошибка: ${error ?? 'нет кода'}`);
        server.close();
        return;
    }

    try {
        const tokens = await exchangeCode(code);

        // Записываем refresh token в .env
        let env = fs.readFileSync('.env', 'utf8');
        if (env.includes('SPOTIFY_REFRESH_TOKEN=')) {
            env = env.replace(/SPOTIFY_REFRESH_TOKEN=.*/,  `SPOTIFY_REFRESH_TOKEN=${tokens.refresh_token}`);
        } else {
            env += `\nSPOTIFY_REFRESH_TOKEN=${tokens.refresh_token}`;
        }
        fs.writeFileSync('.env', env);

        console.log('Готово! SPOTIFY_REFRESH_TOKEN записан в .env');
        console.log('Теперь можно запускать бота: node index.js\n');

        res.end('<h2>Авторизация успешна! Можно закрыть эту вкладку.</h2>');
    } catch (err) {
        console.error('Ошибка при обмене кода:', err.message);
        res.end(`Ошибка: ${err.message}`);
    }

    server.close();
});

server.listen(8888);

function exchangeCode(code) {
    return new Promise((resolve, reject) => {
        const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
        const body  = `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

        const req = https.request({
            hostname: 'accounts.spotify.com',
            path: '/api/token',
            method: 'POST',
            headers: {
                'Authorization': `Basic ${creds}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (!json.refresh_token) reject(new Error(json.error_description ?? 'No refresh token'));
                    else resolve(json);
                } catch { reject(new Error('Invalid JSON')); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}
