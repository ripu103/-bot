import { MessageFlags } from 'discord.js';
import { handlePurchaseButton, handlePurchaseModal, handlePurchaseSelect } from './purchaseFlow.js';
import { handleAplButton, handleAplSelect } from './adminActions.js';
import { handleMiscButton, handleMiscModal, handleMiscSelect } from './misc.js';

async function safeReply(interaction, error) {
  const message = `処理中にエラーが発生しました: ${error.message}`;
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message);
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }
  } catch {
    /* 応答できない場合は無視 */
  }
}

export async function routeComponent(interaction) {
  try {
    if (interaction.isButton()) {
      if (await handlePurchaseButton(interaction)) return;
      if (await handleAplButton(interaction)) return;
      if (await handleMiscButton(interaction)) return;
    }
    if (interaction.isStringSelectMenu() || interaction.isAnySelectMenu?.()) {
      if (await handlePurchaseSelect(interaction)) return;
      if (await handleAplSelect(interaction)) return;
      if (await handleMiscSelect(interaction)) return;
    }
    if (interaction.isModalSubmit()) {
      if (await handlePurchaseModal(interaction)) return;
      if (await handleMiscModal(interaction)) return;
    }
  } catch (error) {
    console.error('[component]', interaction.customId, error);
    await safeReply(interaction, error);
  }
}
