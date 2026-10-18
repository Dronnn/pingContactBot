import { api } from 'sdk';
import * as store from './store.js';
import { LIMITS } from './config.js';
import { requireConversation, requireActive, checkGroupDestination } from './access.js';
import { button as b, keyboard as kb, validateMessage, unavailable, UserError } from './domain.js';
import { send } from './ui.js';

export async function relay(ctx, conversationId, rawText, expectedSide = null) {
  const text = validateMessage(rawText);
  let { conversation: v, side } = await requireConversation(ctx, conversationId);
  if (expectedSide && expectedSide !== side) throw unavailable();
  await requireActive(v);
  if (side === 'visitor') {
    if (!await store.allowRate(`visitor-minute:${ctx.user.id}`, LIMITS.visitorMessagesPerMinute, 60_000)
        || !await store.allowRate(`visitor-hour:${ctx.user.id}`, LIMITS.visitorMessagesPerHour, 3_600_000)) {
      throw new UserError('Слишком много сообщений. Подожди немного: до 5 сообщений в минуту и 30 в час.');
    }
    if (!await store.allowRate(`incoming:${v.owner_chat_id}`, LIMITS.incomingPerChatMinute, 60_000)) {
      throw new UserError('Сейчас у контакта много обращений. Попробуй через минуту.');
    }
    await checkGroupDestination(ctx, v);
  }

  const direction = side === 'visitor' ? 'to_owner' : 'to_visitor';
  let target = side === 'visitor' ? v.owner_chat_id : v.visitor_id;
  const deliveryKey = `${ctx.eventKey}:${v.id}:${direction}`;
  if (!await store.reserveDelivery(deliveryKey, v, direction, target)) {
    const existing = await store.getDelivery(deliveryKey);
    if (existing?.status === 'sent') return;
    if (existing) throw new UserError('Этот запрос уже обрабатывался. Статус доставки не подтверждён; если ответа нет, отправь новый текст вручную.');
    throw unavailable();
  }

  const markup = side === 'visitor'
    ? kb([[b('Ответить', `reply:${v.id}`), b('Диалог', `dialog:${v.id}`)], [b('Заблокировать', `askblock:${v.id}`)]])
    : kb([[b('Написать ещё', `reply:${v.id}`), b('Завершить', `askclose:${v.id}`)]]);
  const body = `${side === 'visitor' ? 'По поводу' : 'Ответ по поводу'} «${v.title}»\n${side === 'visitor' ? 'Собеседник' : 'Диалог'} #${v.id}\n\n${text}`;
  const params = () => ({
    chat_id: target, text: body, reply_markup: markup,
    ...(side === 'visitor' && v.topic_id ? { message_thread_id: v.topic_id } : {}),
    link_preview_options: { is_disabled: true },
    // Не используем forward/copyMessage, entities, username, имя или подпись отправителя.
  });

  let result;
  try {
    try {
      result = await api.sendMessage(params());
    } catch (error) {
      // Telegram явно отказал и указал новый chat_id — здесь повтор безопасен.
      // Сетевые timeout и обычные 5xx автоматически не повторяем.
      if (side === 'visitor' && Number.isSafeInteger(error.parameters?.migrate_to_chat_id)) {
        await store.migrateChat(target, error.parameters.migrate_to_chat_id);
        v = await store.getConversation(v.id);
        await requireActive(v);
        target = v.owner_chat_id;
        result = await api.sendMessage(params());
      } else throw error;
    }
  } catch (error) {
    const code = error.code || error.error_code;
    const definiteRejection = code >= 400 && code < 500;
    try { await store.finishDelivery(deliveryKey, definiteRejection ? 'failed' : 'unknown'); }
    catch (dbError) { console.warn('Could not record rejected or uncertain delivery', { code: dbError.code || 'DB' }); }
    if (code === 429) throw new UserError(`Telegram ограничил частоту отправки. Сообщение не отправлено. Повтори через ${error.parameters?.retry_after || 60} сек.`);
    if (code === 403) throw new UserError('Сообщение не отправлено: получатель сейчас недоступен. Возможно, бот удалён из чата или заблокирован.');
    if (definiteRejection) throw new UserError('Telegram отклонил отправку. Сообщение не доставлено. Для контакта группы администратор может проверить /setup и перенести его через /move номер.');
    throw new UserError('Telegram не подтвердил доставку. Сообщение могло прийти; автоматического повтора не будет. Если нужно, проверь ответ и отправь новый текст вручную.');
  }

  try {
    await store.saveRoute(target, result.message_id, side === 'visitor' ? v.topic_id : 0, v.id, side === 'visitor' ? 'owner' : 'visitor');
    await store.finishDelivery(deliveryKey, 'sent', result.message_id);
    await store.touchConversation(v.id);
  } catch (error) {
    // Telegram уже принял сообщение. Ошибка локальной записи не превращает его в «не доставлено».
    // Кнопка «Ответить» содержит conversation ID и работает даже без reply-route.
    console.error('Delivery metadata could not be saved', { conversationId: v.id, code: error.code || 'DB' });
  }
  try {
    if (side === 'visitor') await store.setSession(ctx.chat.id, ctx.user.id, 'visit', v.id, 0, 0);
    else await store.clearSession(ctx.chat.id, ctx.user.id);
    await send(ctx, side === 'visitor'
      ? `Сообщение отправлено ${v.owner_kind === 'group' ? 'в группу' : 'владельцу'}.\nПо поводу «${v.title}» · диалог #${v.id}.\nМожно написать ещё или выйти из диалога.`
      : `Ответ отправлен в диалог #${v.id} по поводу «${v.title}».`,
      kb(side === 'visitor' ? [[b('Диалог', `dialog:${v.id}`), b('Выйти из ввода', 'cancel')]] : [[b('Диалог', `dialog:${v.id}`)]]));
  } catch (error) {
    // Ошибка подтверждения отправителю не отменяет уже успешную доставку адресату.
    console.warn('Delivery acknowledgement unavailable', { code: error.code || 'DB' });
  }
}
