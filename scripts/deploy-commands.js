import { loadEnv } from '../src/env.js';

loadEnv();

const { REST, Routes } = await import('discord.js');
const { config } = await import('../src/config.js');
const { commands } = await import('../src/commands/index.js');

const body = commands.map((command) => command.data.toJSON());
const rest = new REST({ version: '10' }).setToken(config.token);

const route = config.guildId
  ? Routes.applicationGuildCommands(config.applicationId, config.guildId)
  : Routes.applicationCommands(config.applicationId);

const result = await rest.put(route, { body });
console.log(`登録しました: ${result.length}件（${config.guildId ? `ギルド ${config.guildId}` : 'グローバル'}）`);
console.log(result.map((command) => `/${command.name}`).join(' '));
