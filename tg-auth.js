// Запусти один раз: node tg-auth.js
// Авторизуется в Telegram и сохраняет сессию в .env

require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const readline = require('readline');

const apiId = parseInt(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;

if (!apiId || !apiHash) {
    console.error('Нет TG_API_ID / TG_API_HASH в .env');
    process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

(async () => {
    const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
        connectionRetries: 3,
    });

    await client.start({
        phoneNumber: async () => await ask('Номер телефона (+7...): '),
        password: async () => await ask('Пароль 2FA (если есть): '),
        phoneCode: async () => await ask('Код из Telegram: '),
        onError: (err) => console.error('Ошибка:', err),
    });

    const session = client.session.save();

    const fs = require('fs');
    let env = fs.readFileSync('.env', 'utf8');
    if (env.includes('TG_SESSION=')) {
        env = env.replace(/TG_SESSION=.*/, `TG_SESSION=${session}`);
    } else {
        env += `\nTG_SESSION=${session}`;
    }
    fs.writeFileSync('.env', env);

    console.log('\nГотово! TG_SESSION записан в .env');
    console.log('Теперь можно запускать бота: node index.js\n');

    await client.disconnect();
    rl.close();
    process.exit(0);
})();
