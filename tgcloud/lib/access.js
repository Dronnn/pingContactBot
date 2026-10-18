import { api } from 'sdk';
import * as store from './store.js';
import { isGroup, memberCanReply, memberIsAdmin, unavailable, UserError } from './domain.js';

export async function botInfo(ctx) {
  if (!ctx.me) ctx.me = await api.getMe();
  return ctx.me;
}

export async function requireMember(ctx, manage = false) {
  if (!ctx.user?.id || ctx.user.is_bot) throw new UserError('Открой бота со своего Telegram-аккаунта.');
  if (ctx.chat.type === 'private') {
    if (ctx.chat.id !== ctx.user.id) throw unavailable();
    return;
  }
  if (!isGroup(ctx.chat)) throw new UserError('Поддерживаются личные сообщения, группы и супергруппы.');
  let botMember, actor;
  try {
    const me = await botInfo(ctx);
    botMember = await api.getChatMember({ chat_id: ctx.chat.id, user_id: me.id });
    if (!memberIsAdmin(botMember)) throw new UserError('Для общего контакта назначь бота администратором группы. Права на удаление сообщений и приглашение людей ему не нужны. Затем отправь /setup.');
    actor = await api.getChatMember({ chat_id: ctx.chat.id, user_id: ctx.user.id });
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError('Не удалось проверить участие в группе. Убедись, что бот — администратор, и повтори действие.');
  }
  if (manage && !memberIsAdmin(actor)) throw new UserError('Контактами и блокировками группы управляют её администраторы.');
  if (!memberCanReply(actor)) throw new UserError('Это действие доступно участникам группы с правом писать сообщения.');
}

export async function requireContact(ctx, id, manage = false) {
  const contact = await store.getContact(id);
  if (!contact || contact.deleted || contact.owner_chat_id !== ctx.chat.id) throw unavailable();
  await requireMember(ctx, manage);
  return contact;
}

export async function requireConversation(ctx, id, manage = false) {
  const conversation = await store.getConversation(id);
  if (!conversation || conversation.deleted) throw unavailable();
  if (conversation.owner_chat_id === ctx.chat.id) {
    await requireMember(ctx, manage);
    return { conversation, side: 'owner' };
  }
  if (ctx.chat.type === 'private' && ctx.chat.id === ctx.user.id && conversation.visitor_id === ctx.user.id) {
    return { conversation, side: 'visitor' };
  }
  throw unavailable();
}

export async function requireActive(conversation) {
  if (conversation.deleted || !conversation.enabled || conversation.generation !== conversation.contact_generation) throw unavailable();
  if (await store.isBlocked(conversation.owner_chat_id, conversation.visitor_id)) throw unavailable();
  if (conversation.status !== 'open' || conversation.visitor_muted) throw new UserError('Диалог завершён. Открой его через /inbox; возобновление доступно, если собеседник не отключил ответы.');
}

export async function checkGroupDestination(ctx, conversation) {
  if (conversation.owner_kind !== 'group') return;
  try {
    const me = await botInfo(ctx);
    const member = await api.getChatMember({ chat_id: conversation.owner_chat_id, user_id: me.id });
    if (!memberIsAdmin(member)) throw unavailable();
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError('Сейчас не удалось проверить чат получателя. Попробуй позднее.');
  }
}
