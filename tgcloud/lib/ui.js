import { api, InputFile } from 'sdk';
import * as store from './store.js';
import { LIMITS } from './config.js';
import { botInfo, requireMember, requireContact, requireConversation } from './access.js';
import { button as b, keyboard as kb, contactLink, shortTitle, cleanText, isGroup, PRIVACY_TEXT, UserError } from './domain.js';
import { createQrPng } from './qr.js';

export async function send(ctx, text, replyMarkup, extra = {}) {
  return api.sendMessage({
    chat_id: ctx.chat.id, text,
    ...(ctx.topicId ? { message_thread_id: ctx.topicId } : {}),
    link_preview_options: { is_disabled: true },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    ...extra,
  });
}

export async function menu(ctx) {
  await requireMember(ctx);
  await store.clearSession(ctx.chat.id, ctx.user.id);
  const group = isGroup(ctx.chat);
  const rows = [
    [b(group ? 'Контакты чата' : 'Мои контакты', 'contacts:0'), b('Диалоги', 'inbox:0')],
    [b('Создать контакт', 'new'), b('Помощь', 'help')],
  ];
  if (!group) rows.push([{ text: 'Добавить в группу', url: `https://t.me/${(await botInfo(ctx)).username}?startgroup=contact` }]);
  return send(ctx, group
    ? 'Контакт для вещи\n\nСоздайте общую карточку: «Дверь мастерской», «Объявление» или «Машина». Человек откроет QR и напишет боту в личку. Обращение придёт сюда, ответить сможет участник чата. Настройки и блокировки — у администраторов.'
    : 'Контакт для вещи\n\nСоздай карточку машины, рюкзака или объявления. Получи ссылку и QR. Собеседник напишет тебе через бота без обмена личными контактами.\n\nДля связи с чужой вещью открой её QR или ссылку.', kb(rows));
}

export async function contactList(ctx, page = 0) {
  await requireMember(ctx);
  await store.clearSession(ctx.chat.id, ctx.user.id);
  const contacts = await store.listContacts(ctx.chat.id, page * LIMITS.pageSize);
  const rows = contacts.slice(0, LIMITS.pageSize).map((c) => [b(`${c.enabled ? 'Включён' : 'Отключён'} · ${shortTitle(c.title)}`, `card:${c.id}`)]);
  const nav = [];
  if (page > 0) nav.push(b('Назад', `contacts:${page - 1}`));
  if (contacts.length > LIMITS.pageSize) nav.push(b('Далее', `contacts:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([b('Создать контакт', 'new'), b('Меню', 'menu')]);
  return send(ctx, contacts.length ? `${isGroup(ctx.chat) ? 'Контакты чата' : 'Мои контакты'} · страница ${page + 1}\nНажми на карточку, чтобы получить QR, ссылку или открыть настройки.` : 'На этой странице контактов пока нет. Создай карточку кнопкой ниже.', kb(rows));
}

export async function contactCard(ctx, id) {
  const c = await requireContact(ctx, id);
  await store.clearSession(ctx.chat.id, ctx.user.id);
  const link = contactLink((await botInfo(ctx)).username, c.token);
  const topic = c.owner_kind === 'group' ? `\nОбращения: ${c.topic_id ? 'тема ' + c.topic_id : 'общий чат'}.` : '';
  return send(ctx, `${c.title}\nКонтакт №${c.id} · ${c.enabled ? 'включён' : 'отключён'}${topic}${c.description ? '\n\n' + c.description : ''}\n\n${link}\n\nНазвание и описание видны всем, кто откроет ссылку.`, kb([
    [b('QR-код', `qr:${c.id}`), b('QR для печати', `print:${c.id}`)],
    [b('Название', `rename:${c.id}`), b('Описание', `description:${c.id}`)],
    [b(c.enabled ? 'Отключить' : 'Включить', `${c.enabled ? 'disable' : 'enable'}:${c.id}`)],
    [b('Заменить ссылку', `askrotate:${c.id}`), b('Удалить карточку', `askdelete:${c.id}`)],
    [b('Диалоги', 'inbox:0'), b('Все контакты', 'contacts:0')],
  ]));
}

export async function qr(ctx, id, asDocument = false) {
  const c = await requireContact(ctx, id);
  await store.clearSession(ctx.chat.id, ctx.user.id);
  if (!await store.allowRate(`qr:${ctx.user.id}`, 8, 60_000)) throw new UserError('QR уже готовился несколько раз. Подожди минуту.');
  const link = contactLink((await botInfo(ctx)).username, c.token);
  const bytes = createQrPng(link);
  const params = {
    chat_id: ctx.chat.id,
    ...(ctx.topicId ? { message_thread_id: ctx.topicId } : {}),
    caption: `${c.title}\nНапишите через Telegram\n\n${link}${!c.enabled ? '\n\nКонтакт сейчас отключён.' : ''}`,
    reply_markup: kb([[b('Открыть карточку', `card:${c.id}`), b(asDocument ? 'QR-картинка' : 'Файл для печати', `${asDocument ? 'qr' : 'print'}:${c.id}`)]]),
  };
  const file = new InputFile(bytes, `contact-${c.id}-qr.png`, { type: 'image/png' });
  return asDocument ? api.sendDocument({ ...params, document: file }) : api.sendPhoto({ ...params, photo: file });
}

export async function inbox(ctx, page = 0) {
  await requireMember(ctx);
  await store.clearSession(ctx.chat.id, ctx.user.id);
  const list = await store.listConversations(ctx.chat.id, ctx.user.id, !isGroup(ctx.chat), page * LIMITS.pageSize);
  const rows = list.slice(0, LIMITS.pageSize).map((v) => {
    const side = v.owner_chat_id === ctx.chat.id ? 'Входящий' : 'Моё обращение';
    const closed = v.status === 'closed' || v.generation !== v.contact_generation ? ' · закрыт' : '';
    return [b(`#${v.id} · ${shortTitle(v.title, 24)} · ${side}${closed}`, `dialog:${v.id}`)];
  });
  const nav = [];
  if (page > 0) nav.push(b('Назад', `inbox:${page - 1}`));
  if (list.length > LIMITS.pageSize) nav.push(b('Далее', `inbox:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([b('Меню', 'menu')]);
  return send(ctx, list.length ? `Диалоги · страница ${page + 1}\nЗдесь список обращений. Тексты остаются в переписке Telegram.` : 'На этой странице диалогов пока нет. Новые обращения появятся после перехода по ссылке контакта.', kb(rows));
}

export async function dialog(ctx, id) {
  const { conversation: v, side } = await requireConversation(ctx, id);
  await store.clearSession(ctx.chat.id, ctx.user.id);
  const blocked = await store.isBlocked(v.owner_chat_id, v.visitor_id);
  const expired = v.generation !== v.contact_generation;
  const unavailable = expired || !v.enabled || (side === 'visitor' && blocked);
  if (side === 'visitor' && blocked) throw new UserError('Контакт сейчас недоступен.');
  const status = expired ? 'Ссылка заменена. Для новых сообщений нужна действующая ссылка.'
    : !v.enabled ? 'Карточка отключена.' : blocked ? 'Собеседник заблокирован для всех ваших контактов.'
    : v.visitor_muted ? (side === 'visitor' ? 'Ты завершил диалог и отключил ответы.' : 'Собеседник завершил диалог и отключил ответы.')
    : v.status === 'closed' ? 'Диалог завершён.' : 'Диалог открыт.';
  const rows = [];
  if (!unavailable && !blocked) {
    if (v.status === 'open' && !v.visitor_muted) rows.push([b(side === 'owner' ? 'Ответить' : 'Написать', `reply:${v.id}`), b('Завершить', `askclose:${v.id}`)]);
    else if (side === 'visitor' || !v.visitor_muted) rows.push([b('Возобновить диалог', `reopen:${v.id}`)]);
  }
  if (side === 'owner') {
    rows.push([b(blocked ? 'Разблокировать' : 'Заблокировать', `${blocked ? 'unblock' : 'askblock'}:${v.id}`)]);
    rows.push([b('Карточка', `card:${v.contact_id}`)]);
  }
  rows.push([b('Все диалоги', 'inbox:0')]);
  return send(ctx, `По поводу «${v.title}»\nДиалог #${v.id}\n${status}\n\n${side === 'owner' ? 'Ответ поступит собеседнику от имени контакта.' : v.owner_kind === 'group' ? 'Сообщения увидят участники группы. Ответ придёт от имени контакта.' : 'Сообщения получит владелец контакта.'}`, kb(rows));
}

export async function blockedList(ctx, page = 0) {
  await requireMember(ctx, true);
  await store.clearSession(ctx.chat.id, ctx.user.id);
  const list = await store.listBlocks(ctx.chat.id, page * LIMITS.pageSize);
  const rows = list.slice(0, LIMITS.pageSize).map((item) => [b(`Разблокировать собеседника #${item.conversation_id}`, `unblockid:${item.id}`)]);
  const nav = [];
  if (page > 0) nav.push(b('Назад', `blocked:${page - 1}`));
  if (list.length > LIMITS.pageSize) nav.push(b('Далее', `blocked:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([b('Контакты', 'contacts:0')]);
  return send(ctx, list.length ? 'Блокировки действуют на все контакты этого владельца или группы. Личные профили собеседников не показываются.' : 'Заблокированных собеседников нет.', kb(rows));
}

export async function prompt(ctx, kind, refId, text) {
  // Callback не является сообщением пользователя. text_mention адресует ForceReply
  // настоящему нажавшему, а session дополнительно проверяет chat+user+prompt.
  const name = cleanText(ctx.user.first_name || 'Участник').replace(/\s+/g, ' ').slice(0, 50) || 'Участник';
  const group = isGroup(ctx.chat);
  const message = await send(ctx, `${group ? name + ', ' : ''}${text}\n\nОтмена: /cancel.`, { force_reply: true, selective: group, input_field_placeholder: kind.startsWith('reply') ? 'Текст собеседнику' : 'Ответ для бота' },
    group ? { entities: [{ type: 'text_mention', offset: 0, length: name.length, user: { id: ctx.user.id, is_bot: false, first_name: name } }] } : {});
  await store.setSession(ctx.chat.id, ctx.user.id, kind, refId, message.message_id, ctx.topicId || 0);
  return message;
}

export async function help(ctx) {
  await store.clearSession(ctx.chat.id, ctx.user.id);
  return send(ctx, `Контакт для вещи\n\n/new Моя машина — создать карточку и ссылку.\n/contacts — карточки, QR, название, описание, отключение и замена ссылки.\n/inbox — список диалогов.\n/reply 12 Выхожу — ответить в диалог #12. Без текста бот попросит ответ.\n/blocked — блокировки.\n/move 3 — перенести обращения контакта №3 в текущую тему группы.\n/cancel — отменить свой ввод.\n/setup — проверить подключение и обновить меню команд.\n/privacy — данные и скрытие контактов.\n\nЧтобы ответить, нажми «Ответить» под обращением или сделай Reply на сообщение бота. В группе ответь именно на запрос бота: обычные сообщения чата никуда не передаются. При нескольких ботах указывай /contacts@${(await botInfo(ctx)).username}.\n\nКарточки группы принадлежат всему чату. Участники отвечают, администраторы создают и меняют контакты, закрывают диалоги и управляют блокировками. Бот должен быть администратором.\n\nПервая версия передаёт только текст. Если сам напишешь номер телефона или ссылку на профиль, собеседник их увидит.`, kb([[b('Контакты', 'contacts:0'), b('Диалоги', 'inbox:0')]]));
}
export async function privacy(ctx) {
  await store.clearSession(ctx.chat.id, ctx.user.id);
  return send(ctx, PRIVACY_TEXT, kb([[b('Меню', 'menu')]]));
}
