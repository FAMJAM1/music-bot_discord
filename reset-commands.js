require('dotenv').config();
const { REST, Routes } = require('discord.js');
const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
    await rest.put(Routes.applicationCommands('1499794318188351621'), { body: [] });
    console.log('Команды очищены');
    process.exit(0);
})();
