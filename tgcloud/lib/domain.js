import { LIMITS } from './config.js';

export class UserError extends Error {}

export function isGroup(chat) { return chat?.type === 'group' || chat?.type === 'supergroup'; }
export function validId(value) { return Number.isSafeInteger(value) && value > 0; }
export function integerId(value) {
  if (!/^[1-9][0-9]{0,14}$/.test(String(value))) throw new UserError('Некорректный номер. Открой /contacts или /inbox.');
  const id = Number(value);
  if (!validId(id)) throw new UserError('Некорректный номер.');
  return id;
}

export function parseCommand(text) {
  const match = /^\/([a-z][a-z0-9_]*)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(text || '');
  return match ? { name: match[1].toLowerCase(), username: match[2]?.toLowerCase() || '', args: (match[3] || '').trim() } : null;
}

// Удаляем управляющие символы: они могут маскировать адресата в служебной шапке.
export function cleanText(value) {
  return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '').trim();
}
export function validateTitle(value) {
  const title = cleanText(value).replace(/\s+/g, ' ');
  if (!title || title.length > LIMITS.titleLength) throw new UserError(`Название: от 1 до ${LIMITS.titleLength} символов. Попробуй ещё раз или /cancel.`);
  return title;
}
export function validateDescription(value) {
  const description = cleanText(value);
  if (description.length > LIMITS.descriptionLength) throw new UserError(`Описание: до ${LIMITS.descriptionLength} символов. Попробуй ещё раз или /cancel.`);
  return description === '-' ? '' : description;
}
export function validateMessage(value) {
  const text = cleanText(value);
  if (!text || text.length > LIMITS.textLength) throw new UserError(`Отправь обычный текст длиной от 1 до ${LIMITS.textLength} символов. Фото, голосовые, контакты и файлы в этой версии не передаются.`);
  return text;
}
export function newToken() {
  // Никакого Math.random и запасного предсказуемого генератора для публичной ссылки.
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new UserError('В среде бота недоступен безопасный генератор ссылок. Владелец бота должен проверить версию Telegram Serverless через /setup.');
  }
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => n.toString(16).padStart(2, '0')).join('');
}
export function contactLink(username, token) {
  if (!/^[a-z0-9_]{5,32}$/i.test(username || '') || !/^[a-f0-9]{48}$/.test(token || '')) throw new Error('Invalid bot username or contact token');
  return `https://t.me/${username}?start=c_${token}`;
}
export function tokenFromPayload(payload) {
  const match = /^c_([a-f0-9]{48})$/.exec(payload || '');
  return match?.[1] || null;
}
export function button(text, callback_data) { return { text, callback_data }; }
export function keyboard(rows) { return { inline_keyboard: rows }; }
export function shortTitle(title, max = 34) { return title.length > max ? `${title.slice(0, max - 1)}…` : title; }
export function memberCanReply(member) {
  if (['creator', 'administrator', 'member'].includes(member?.status)) return true;
  return member?.status === 'restricted' && member.is_member === true && member.can_send_messages === true;
}
export function memberIsAdmin(member) { return ['creator', 'administrator'].includes(member?.status); }
export function unavailable() { return new UserError('Контакт сейчас недоступен. Возможно, ссылка отключена или заменена.'); }

export const PRIVACY_TEXT = 'Бот скрывает профиль и номер телефона от собеседника: отправляет новый текст, без пересылки и подписи автора. Название группы и список её участников наружу не передаются.\n\nЛичные контакты, ссылки и любые сведения, написанные в самом тексте, увидит получатель. Обращение к контакту группы читают участники этой группы.\n\nЭто не полная анонимность: Telegram обрабатывает переписку, а владелец бота имеет технический доступ к базе с Telegram ID и связями диалогов. В базе проекта нет текстов переписки; сообщения остаются в Telegram у участников. Формы действуют 30 минут, связи для обычного Reply — 30 дней. Просроченные технические записи удаляются порциями при работе бота; при простое они могут храниться дольше. Карточки, блокировки и список диалогов сохраняются для работы контактов. При удалении карточки её публичные название и описание стираются, служебные связи остаются.\n\nЧтобы перестать получать ответы, открой диалог и нажми «Завершить». Отключить свою карточку, сменить ссылку или удалить её можно в /contacts. В группе это делают администраторы.';
