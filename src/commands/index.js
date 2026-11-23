import * as vending from './vending.js';
import * as products from './products.js';
import * as notifications from './notifications.js';
import * as purchases from './purchases.js';
import * as roles from './roles.js';
import * as moderation from './moderation.js';
import * as server from './server.js';
import * as shop from './shop.js';

export const commands = [
  ...vending.commands,
  ...products.commands,
  ...notifications.commands,
  ...purchases.commands,
  ...roles.commands,
  ...moderation.commands,
  ...server.commands,
  ...shop.commands,
];

export const commandMap = new Map(commands.map((command) => [command.data.name, command]));

export async function handleAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  const name = interaction.commandName;

  if (focused.name === '自販機') return vending.machineAutocomplete(interaction);
  if (focused.name === '商品') return products.productAutocomplete(interaction);
  if (focused.name === 'バックアップ') return server.backupAutocomplete(interaction);

  return interaction.respond([]);
}
