import { api } from 'sdk';
import * as store from './store.js';
import * as ui from './ui.js';
import { LIMITS, PRIVATE_COMMANDS, GROUP_COMMANDS, COMMAND_VERSION } from './config.js';
import { botInfo, requireMember, requireContact, requireConversation, requireActive } from './access.js';
import { relay } from './relay.js';
import {
  isGroup, parseCommand, integerId, tokenFromPayload, newToken, validateTitle, validateDescription,
  UserError, unavailable, button as b, keyboard as kb, memberIsAdmin,
} from './domain.js';

function context(message, user, eventKey) {
  return { chat: message.chat, user, message, eventKey, topicId: message.message_thread_id || 0 };
}

async function handled(ctx, action) {
  try {
    await action();
  } catch (error) {
    const text = error instanceof UserError ? error.message : 'Не удалось завершить действие. Попробуй ещё раз; настройки и диалоги доступны в /contacts и /inbox.';
    if (!(error instanceof UserError)) console.error('Handler failed', { type: error.name || 'Error', code: error.code || 'INTERNAL' });
    try { await ui.send(ctx, text); } catch (notificationError) {
      console.warn('Could not notify initiating chat', { code: notificationError.code || 'UNAVAILABLE' });
    }
  }
}

async function actionBudget(ctx) {
  if (!await store.allowRate(`actions:${ctx.user.id}`, LIMITS.actionsPerMinute, 60_000)) throw new UserError('Слишком много действий. Подожди минуту.');
}

async function installCommands(force = false) {
  if (!force && (await store.getSetting('command_version'))?.value === COMMAND_VERSION) return;
  await api.setMyCommands({ commands: PRIVATE_COMMANDS, scope: { type: 'all_private_chats' } });
  await api.setMyCommands({ commands: GROUP_COMMANDS, scope: { type: 'all_group_chats' } });
  await store.setSetting('command_version', COMMAND_VERSION);
}

async function setup(ctx) {
  await requireMember(ctx, isGroup(ctx.chat));
  const pendingMigration = await store.getSetting(`migration_lock:${ctx.chat.id}`);
  if (pendingMigration) {
    const [oldId, newId] = pendingMigration.value.split(':').map(Number);
    await store.migrateChat(oldId, newId);
  }
  const cryptoReady = typeof globalThis.crypto?.getRandomValues === 'function';
  await installCommands(true);
  await ui.send(ctx, `Меню команд обновлено.\nБаза данных: доступна.\nСоздание безопасных ссылок: ${cryptoReady ? 'доступно' : 'недоступно — нужен Web Crypto в Telegram Serverless'}.\n${isGroup(ctx.chat) ? 'Бот — администратор. Контакты и диалоги принадлежат этому чату.\nЕсли бот был удалён или лишён прав, включи нужные карточки вручную в /contacts.' : 'Личные контакты и переписка готовы. Для общего контакта добавь бота в группу и назначь администратором.'}`, kb([[b('Контакты', 'contacts:0'), b('Создать контакт', 'new')]]));
}

async function newContact(ctx, title) {
  await requireMember(ctx, true);
  if (!title) return ui.prompt(ctx, 'new', 0, 'напиши название контакта. Например: «Моя машина». Его увидят посетители ссылки; не добавляй личные контакты.');
  title = validateTitle(title);
  if (!await store.allowRate(`create:${ctx.chat.id}`, LIMITS.contactsPerHour, 3_600_000)) throw new UserError('Можно создавать до 5 контактов в час. Подожди или измени существующую карточку.');
  const c = await store.createContact({
    chatId: ctx.chat.id, kind: isGroup(ctx.chat) ? 'group' : 'private', title, token: newToken(),
    topicId: isGroup(ctx.chat) ? ctx.topicId : 0, userId: ctx.user.id, eventKey: ctx.eventKey,
  });
  if (!c) throw new UserError(`В этом чате уже ${LIMITS.contactsPerChat} контактов. Удали ненужный в /contacts.`);
  await store.clearSession(ctx.chat.id, ctx.user.id);
  await ui.contactCard(ctx, c.id);
  try { await ui.qr(ctx, c.id); }
  catch (error) { await ui.send(ctx, 'Карточка создана. Сейчас не удалось отправить QR; его можно получить кнопкой «QR-код» в карточке.'); }
}

async function openLink(ctx, token) {
  if (ctx.chat.type !== 'private') throw new UserError('Ссылку контакта нужно открыть в личных сообщениях с ботом.');
  const c = await store.getContactByToken(token);
  if (!c || await store.isBlocked(c.owner_chat_id, ctx.user.id)) throw unavailable();
  if (c.owner_chat_id === ctx.chat.id) return ui.contactCard(ctx, c.id);
  if (!await store.allowRate(`visits:${ctx.user.id}`, LIMITS.newConversationsPerDay, 86_400_000)) throw new UserError('Слишком много открытий контактов за день. Попробуй позднее.');
  const v = await store.openConversation(c, ctx.user.id);
  if (!v) throw unavailable();
  if (v.status !== 'open' || v.visitor_muted) return ui.dialog(ctx, v.id);
  await store.setSession(ctx.chat.id, ctx.user.id, 'visit', v.id);
  return ui.send(ctx, `${c.title}${c.description ? '\n\n' + c.description : ''}\n\n${c.owner_kind === 'group' ? 'Сообщение увидят участники группы.' : 'Сообщение получит владелец контакта.'}\nБот не передаёт твой профиль и номер телефона. Контакты, написанные в самом тексте, будут видны.\n\nНапиши сообщение по поводу этой вещи. Только текст, до ${LIMITS.textLength} символов.`, kb([[b('Диалог', `dialog:${v.id}`), b('Отмена', 'cancel')], [b('О данных', 'privacy')]]));
}

async function replyPrompt(ctx, id) {
  const { conversation: v, side } = await requireConversation(ctx, id);
  await requireActive(v);
  return ui.prompt(ctx, `reply_${side}`, v.id, `напиши ${side === 'owner' ? 'ответ собеседнику' : 'сообщение'} по поводу «${v.title}», диалог #${await ui.dialogNumber(v, side)}. ${side === 'visitor' && v.owner_kind === 'group' ? 'Его увидят участники группы.' : ''}`);
}

async function handleCommand(ctx, command) {
  const [head, ...rest] = command.args.split(/\s+/);
  switch (command.name) {
    case 'start':
      await store.clearSession(ctx.chat.id, ctx.user.id);
      try { await installCommands(); } catch (error) { console.warn('Command menu setup deferred', { code: error.code || 'API' }); }
      if (command.args && ctx.chat.type === 'private') {
        const token = tokenFromPayload(command.args);
        if (!token) throw unavailable();
        return openLink(ctx, token);
      }
      return ui.menu(ctx);
    case 'new': return newContact(ctx, command.args);
    case 'contacts': return ui.contactList(ctx);
    case 'inbox': return ui.inbox(ctx);
    case 'blocked': return ui.blockedList(ctx);
    case 'help': return ui.help(ctx);
    case 'privacy': return ui.privacy(ctx);
    case 'setup': return setup(ctx);
    case 'cancel':
      await store.clearSession(ctx.chat.id, ctx.user.id);
      return ui.send(ctx, 'Ввод отменён. Новые сообщения не будут отправляться собеседнику автоматически. Ответы на конкретное сообщение бота остаются доступны.', kb([[b('Контакты', 'contacts:0'), b('Диалоги', 'inbox:0')]]));
    case 'reply': {
      if (!head) throw new UserError('Формат: /reply 12 Текст ответа. Номер диалога есть в /inbox.');
      const number = integerId(head);
      const found = await store.conversationByNumber(ctx.chat.id, ctx.user.id, !isGroup(ctx.chat), number);
      if (!found) throw new UserError(`Диалога №${number} нет в /inbox. Открой список и ответь кнопкой «Ответить».`);
      if (!rest.length) return replyPrompt(ctx, found.id);
      return relay(ctx, found.id, command.args.slice(head.length).trim());
    }
    case 'move': {
      if (!isGroup(ctx.chat)) throw new UserError('Эта команда нужна в группе: /move номер_контакта.');
      if (!head) throw new UserError('Открой нужную тему и отправь /move номер_контакта. Номер есть в /contacts.');
      const id = integerId(head);
      await requireContact(ctx, id, true);
      await store.updateContact(id, ctx.chat.id, { topic_id: ctx.topicId });
      return ui.contactCard(ctx, id);
    }
    default: return ui.send(ctx, 'Такой команды нет. Открой /help или меню.', kb([[b('Меню', 'menu')]]));
  }
}

async function handleSession(ctx, session, message) {
  if (!message.text) throw new UserError('Для этого действия нужен обычный текст. Фото, голосовые, контакты и файлы не передаются.');
  if (session.kind === 'visit') return relay(ctx, session.ref_id, message.text, 'visitor');
  // Даже в личке ответ должен относиться к точному prompt. Это защищает от старых форм.
  if (message.reply_to_message?.message_id !== session.prompt_id || (message.message_thread_id || 0) !== session.topic_id) {
    if (!isGroup(ctx.chat)) throw new UserError('Ответь именно на запрос бота через Reply или нажми нужную кнопку снова. Отмена: /cancel.');
    return;
  }
  switch (session.kind) {
    case 'new': return newContact(ctx, message.text);
    case 'rename':
    case 'description': {
      await requireContact(ctx, session.ref_id, true);
      const value = session.kind === 'rename' ? validateTitle(message.text) : validateDescription(message.text);
      const changed = await store.updateContact(session.ref_id, ctx.chat.id, { [session.kind === 'rename' ? 'title' : 'description']: value });
      if (!changed) throw unavailable();
      await store.clearSessionIfPrompt(ctx.chat.id, ctx.user.id, session.prompt_id);
      return ui.contactCard(ctx, session.ref_id);
    }
    case 'reply_owner':
    case 'reply_visitor': {
      await relay(ctx, session.ref_id, message.text, session.kind === 'reply_owner' ? 'owner' : 'visitor');
      // relay для посетителя уже заменил форму на активный диалог (prompt_id=0).
      await store.clearSessionIfPrompt(ctx.chat.id, ctx.user.id, session.prompt_id);
      return;
    }
    default:
      await store.clearSession(ctx.chat.id, ctx.user.id);
  }
}

export async function onMessage(message, rawCtx = {}) {
  if (!message?.chat || !['private', 'group', 'supergroup'].includes(message.chat.type)) return;
  const eventKey = `message:${message.chat.id}:${message.message_id}`;
  if (message.migrate_to_chat_id || message.migrate_from_chat_id) {
    // Служебные migration updates не обязаны содержать обычного User.
    if (message.migrate_to_chat_id) await store.migrateChat(message.chat.id, message.migrate_to_chat_id);
    if (message.migrate_from_chat_id) await store.migrateChat(message.migrate_from_chat_id, message.chat.id);
    return;
  }
  const command = parseCommand(message.text);
  if (message.sender_chat) {
    // У анонимных администраторов from может быть фиктивным пользователем.
    if (command || message.reply_to_message) {
      try { await ui.send(context(message, null, eventKey), 'Отправь команду или ответ от своего аккаунта, отключив «Анонимность» для этого сообщения. Действия от имени канала или группы не принимаются.'); } catch {}
    }
    return;
  }
  if (!message.from || message.from.is_bot) return;
  const ctx = context(message, message.from, eventKey);
  await handled(ctx, async () => {
    if (command?.username && command.username !== (await botInfo(ctx)).username?.toLowerCase()) return;
    // Бот-администратор получает все сообщения группы. Обычную беседу не читаем в маршрутизатор.
    if (isGroup(ctx.chat) && !command && !message.reply_to_message) return;
    if (!await store.claimEvent(eventKey)) return;
    await actionBudget(ctx);
    await store.sweepExpired();
    if (command) return handleCommand(ctx, command);
    const session = await store.getSession(ctx.chat.id, ctx.user.id);
    if (message.reply_to_message) {
      if (session?.prompt_id === message.reply_to_message.message_id) return handleSession(ctx, session, message);
      const route = await store.getRoute(ctx.chat.id, message.reply_to_message.message_id);
      if (route) {
        if (route.topic_id !== (message.message_thread_id || 0)) throw unavailable();
        return relay(ctx, route.conversation_id, message.text, route.side);
      }
      const me = await botInfo(ctx);
      if (message.reply_to_message.from?.id === me.id) {
        throw new UserError('Этот ответ больше не связан с активной формой или диалогом. Нажми «Ответить» под обращением либо открой /inbox.');
      }
      // Reply на чужое сообщение не становится сообщением активному посетителю.
      return;
    }
    if (session) return handleSession(ctx, session, message);
    if (ctx.chat.type === 'private') return ui.send(ctx, 'Открой QR или ссылку вещи, чтобы написать владельцу. Для своих карточек — /contacts. Для ответа собеседнику нажми «Ответить» под его сообщением.', kb([[b('Создать контакт', 'new'), b('Мои диалоги', 'inbox:0')]]));
  });
}

function pageNumber(value) {
  if (!/^\d{1,5}$/.test(value || '')) throw new UserError('Некорректная страница.');
  return Number(value);
}

async function confirm(ctx, text, yesText, yesData, noData) {
  return ui.send(ctx, text, kb([[b(yesText, yesData)], [b('Отмена', noData)]]));
}

async function handleCallback(ctx, data) {
  const [action, arg, version, extra] = data.split(':');
  if (extra !== undefined) throw unavailable();
  if (['menu', 'new', 'help', 'privacy', 'cancel'].includes(action)) {
    if (arg !== undefined) throw unavailable();
    if (action === 'menu') return ui.menu(ctx);
    if (action === 'new') return newContact(ctx);
    if (action === 'help') return ui.help(ctx);
    if (action === 'privacy') return ui.privacy(ctx);
    return handleCommand(ctx, { name: 'cancel', args: '' });
  }
  if (['contacts', 'inbox', 'blocked'].includes(action)) {
    if (version !== undefined) throw unavailable();
    const page = pageNumber(arg);
    if (action === 'contacts') return ui.contactList(ctx, page);
    if (action === 'inbox') return ui.inbox(ctx, page);
    return ui.blockedList(ctx, page);
  }
  const id = integerId(arg);
  if (version !== undefined && action !== 'rotate') throw unavailable();
  switch (action) {
    case 'card': return ui.contactCard(ctx, id);
    case 'qr': return ui.qr(ctx, id);
    case 'print': return ui.qr(ctx, id, true);
    case 'dialog': return ui.dialog(ctx, id);
    case 'reply': return replyPrompt(ctx, id);
    case 'rename':
    case 'description': {
      const c = await requireContact(ctx, id, true);
      return ui.prompt(ctx, action, c.id, action === 'rename'
        ? `напиши новое публичное название для «${c.title}» (до ${LIMITS.titleLength} символов).`
        : `напиши публичное описание (до ${LIMITS.descriptionLength} символов) или отправь «-», чтобы убрать его.`);
    }
    case 'enable':
    case 'disable': {
      await requireContact(ctx, id, true);
      await store.updateContact(id, ctx.chat.id, { enabled: action === 'enable' ? 1 : 0 });
      return ui.contactCard(ctx, id);
    }
    case 'askrotate': {
      const c = await requireContact(ctx, id, true);
      return confirm(ctx, `Заменить ссылку для «${c.title}»?\n\nСтарый QR перестанет работать. Переписка через старые диалоги остановится. Нужно будет распечатать новый QR и передать новую ссылку.`, 'Заменить ссылку', `rotate:${id}:${c.generation}`, `card:${id}`);
    }
    case 'rotate': {
      await requireContact(ctx, id, true);
      const generation = integerId(version);
      const c = await store.rotateContact(id, ctx.chat.id, newToken(), generation);
      if (!c) await ui.send(ctx, 'Эта ссылка уже была заменена. Показываю действующую карточку.');
      return ui.contactCard(ctx, id);
    }
    case 'askdelete': {
      const c = await requireContact(ctx, id, true);
      return confirm(ctx, `Удалить «${c.title}»? Ссылка, QR и переписка по этой карточке перестанут работать. Сообщения в Telegram останутся.`, 'Удалить карточку', `delete:${id}`, `card:${id}`);
    }
    case 'delete':
      await requireContact(ctx, id, true);
      await store.deleteContact(id, ctx.chat.id, newToken());
      return ui.contactList(ctx);
    case 'askblock': {
      const { conversation: v, side } = await requireConversation(ctx, id, true);
      if (side !== 'owner') throw unavailable();
      return confirm(ctx, `Заблокировать собеседника #${await ui.dialogNumber(v, 'owner')}?\n\nОн не сможет писать ни по одному контакту ${isGroup(ctx.chat) ? 'этой группы' : 'этого владельца'}. Ответы ему тоже остановятся. Разблокировка доступна в /blocked.`, 'Заблокировать', `block:${v.id}`, `dialog:${v.id}`);
    }
    case 'block':
    case 'unblock': {
      const { side } = await requireConversation(ctx, id, true);
      if (side !== 'owner') throw unavailable();
      if (action === 'block') await store.blockConversation(id, ctx.chat.id, ctx.user.id);
      else await store.unblockConversation(id, ctx.chat.id);
      return ui.dialog(ctx, id);
    }
    case 'unblockid':
      await requireMember(ctx, true);
      await store.unblockById(id, ctx.chat.id);
      return ui.blockedList(ctx);
    case 'askclose': {
      const { side } = await requireConversation(ctx, id, true);
      return confirm(ctx, side === 'visitor'
        ? 'Завершить диалог и отключить ответы? Возобновить его сможешь ты через /inbox, пока ссылка действует.'
        : 'Завершить диалог? Его можно возобновить через /inbox. Чтобы запретить новые обращения, используй блокировку.', 'Завершить', `close:${id}`, `dialog:${id}`);
    }
    case 'close': {
      const { side } = await requireConversation(ctx, id, true);
      await store.setConversationState(id, 'closed', side === 'visitor' ? 1 : null);
      await store.clearSession(ctx.chat.id, ctx.user.id);
      return ui.dialog(ctx, id);
    }
    case 'reopen': {
      const { conversation: v, side } = await requireConversation(ctx, id, true);
      if (!v.enabled || v.generation !== v.contact_generation || await store.isBlocked(v.owner_chat_id, v.visitor_id)) throw unavailable();
      if (side === 'owner' && v.visitor_muted) throw new UserError('Собеседник отключил ответы. Возобновить диалог может только он.');
      await store.setConversationState(id, 'open', side === 'visitor' ? 0 : null);
      return replyPrompt(ctx, id);
    }
    default: throw new UserError('Кнопка устарела. Открой /contacts или /inbox.');
  }
}

export async function onCallback(query, rawCtx = {}) {
  if (!query?.id) return;
  if (!query.message?.chat || !query.from || query.from.is_bot || query.message.date === 0 || typeof query.data !== 'string') {
    try { await api.answerCallbackQuery({ callback_query_id: query.id, text: 'Открой актуальное меню бота.', show_alert: true }); } catch {}
    return;
  }
  const ctx = context(query.message, query.from, `callback:${query.id}`);
  // Сразу снимаем индикатор Telegram; результат действия появится сообщением.
  try { await api.answerCallbackQuery({ callback_query_id: query.id }); } catch {}
  await handled(ctx, async () => {
    if (!['private', 'group', 'supergroup'].includes(ctx.chat.type) || query.data.length > 64) throw unavailable();
    if (!await store.claimEvent(ctx.eventKey)) return;
    await actionBudget(ctx);
    await requireMember(ctx);
    await store.sweepExpired();
    await handleCallback(ctx, query.data);
  });
}

export async function onMyChatMember(update, rawCtx = {}) {
  if (!update?.chat || !update.new_chat_member) return;
  const status = update.new_chat_member.status;
  const group = isGroup(update.chat);
  const key = `membership:${update.chat.id}:${rawCtx.update?.update_id ?? `${update.date}:${status}`}`;
  if (!await store.claimEvent(key) || !await store.claimMembership(update.chat.id, update.date, rawCtx.update?.update_id)) return;
  if (['left', 'kicked'].includes(status) || (group && !memberIsAdmin(update.new_chat_member))) {
    await store.disableChat(update.chat.id);
  }
  if (!group || !update.from || update.from.is_bot) return;
  if (['left', 'kicked'].includes(status)) return;
  const ctx = { chat: update.chat, user: update.from, eventKey: key, topicId: 0 };
  await handled(ctx, () => ui.send(ctx, memberIsAdmin(update.new_chat_member)
    ? 'Бот подключён к группе. Создайте общий контакт через /new или откройте /contacts. После повторного подключения включите прежние карточки вручную.'
    : 'Для общих контактов назначьте бота администратором. Права на удаление сообщений и приглашение людей не нужны. Затем отправьте /setup.'));
}
