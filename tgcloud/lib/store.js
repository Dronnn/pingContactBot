import { db } from 'sdk';
import { LIMITS } from './config.js';

const now = () => Date.now();
const one = async (query, params) => (await db.run(query, params)).rows?.[0] || null;
const sessionKey = (chatId, userId) => `${chatId}:${userId}`;

export async function claimEvent(key) {
  return !!await one('INSERT INTO processed_events (key, expires_at) VALUES (:key, :expiry) ON CONFLICT(key) DO NOTHING RETURNING key', {
    ':key': key, ':expiry': now() + LIMITS.eventMs,
  });
}

export const getSetting = (key) => db.get('SELECT value FROM settings WHERE key = :key', { ':key': key });
export async function setSetting(key, value) {
  await db.run('INSERT INTO settings (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { ':key': key, ':value': String(value) });
}

export async function claimMembership(chatId, date, updateId) {
  // Membership — состояние, а не поток сообщений. Устаревший update не должен
  // отменять более позднее повышение бота до администратора.
  const version = `${String(date || 0).padStart(12, '0')}:${String(updateId || 0).padStart(12, '0')}`;
  return !!await one(`INSERT INTO settings (key, value) VALUES (:key, :version)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE settings.value < excluded.value RETURNING key`, {
    ':key': `membership:${chatId}`, ':version': version,
  });
}

export async function allowRate(scope, maximum, windowMs) {
  const start = Math.floor(now() / windowMs) * windowMs;
  return !!await one(`INSERT INTO rate_limits (key, count, expires_at) VALUES (:key, 1, :expiry)
    ON CONFLICT(key) DO UPDATE SET count = rate_limits.count + 1 WHERE rate_limits.count < :maximum RETURNING count`, {
    ':key': `${scope}:${start}`, ':expiry': start + windowMs * 2, ':maximum': maximum,
  });
}

export const getContact = (id) => db.get('SELECT * FROM contacts WHERE id = :id', { ':id': id });
export const getContactByToken = (token) => db.get('SELECT * FROM contacts WHERE token = :token AND deleted = 0 AND enabled = 1', { ':token': token });
export const listContacts = (chatId, offset = 0) => db.all('SELECT * FROM contacts WHERE owner_chat_id = :chat AND deleted = 0 ORDER BY id DESC LIMIT :limit OFFSET :offset', {
  ':chat': chatId, ':limit': LIMITS.pageSize + 1, ':offset': offset,
});

export async function createContact({ chatId, kind, title, token, topicId, userId, eventKey }) {
  const time = now();
  // Лимит и создание проверяются одной SQL-командой: два параллельных /new не обходят лимит.
  const created = await one(`INSERT INTO contacts (owner_chat_id, owner_kind, title, token, topic_id, created_by, creation_key, created_at, updated_at)
    SELECT :chat, :kind, :title, :token, :topic, :user, :event, :time, :time
    WHERE (SELECT count(*) FROM contacts WHERE owner_chat_id = :chat AND deleted = 0) < :maximum
    ON CONFLICT(creation_key) DO NOTHING RETURNING *`, {
    ':chat': chatId, ':kind': kind, ':title': title, ':token': token, ':topic': topicId,
    ':user': userId, ':event': eventKey, ':time': time, ':maximum': LIMITS.contactsPerChat,
  });
  return created || await db.get('SELECT * FROM contacts WHERE creation_key = :event', { ':event': eventKey });
}

export async function updateContact(id, chatId, changes) {
  // Имена колонок берутся только из закрытого списка; пользовательский ввод всегда bound parameters.
  const allowed = ['title', 'description', 'enabled', 'topic_id'];
  const keys = Object.keys(changes);
  if (!keys.length || keys.some((key) => !allowed.includes(key))) throw new Error('Invalid contact update');
  const params = { ':id': id, ':chat': chatId, ':time': now() };
  for (const key of keys) params[`:${key}`] = changes[key];
  return one(`UPDATE contacts SET ${keys.map((key) => `${key} = :${key}`).join(', ')}, updated_at = :time
    WHERE id = :id AND owner_chat_id = :chat AND deleted = 0 RETURNING *`, params);
}

export const rotateContact = (id, chatId, token, generation) => one(`UPDATE contacts SET token = :token, generation = generation + 1, updated_at = :time
  WHERE id = :id AND owner_chat_id = :chat AND deleted = 0 AND generation = :generation RETURNING *`, {
  ':token': token, ':time': now(), ':id': id, ':chat': chatId, ':generation': generation,
});

export const deleteContact = (id, chatId, token) => one(`UPDATE contacts SET token = :token, generation = generation + 1, enabled = 0,
  deleted = 1, title = 'Удалённый контакт', description = '', updated_at = :time
  WHERE id = :id AND owner_chat_id = :chat AND deleted = 0 RETURNING id`, { ':token': token, ':time': now(), ':id': id, ':chat': chatId });

const conversationSelect = `SELECT v.*, c.owner_chat_id, c.owner_kind, c.title, c.description, c.token,
  c.generation AS contact_generation, c.enabled, c.deleted, c.topic_id
  FROM conversations v JOIN contacts c ON c.id = v.contact_id`;

export const getConversation = (id) => db.get(`${conversationSelect} WHERE v.id = :id`, { ':id': id });

// Номер диалога наружу — не глобальный id, а ранг в области видимости одного
// чата: владелец и группа считают диалоги своих карточек (в личке — вместе со
// своими обращениями к чужим), посетитель — все свои обращения. По номеру из
// одного чата нельзя узнать активность остальных. Диалоги не удаляются, поэтому
// номер стабилен; номера диалогов удалённых карточек не переиспользуются.
const numberParams = (chatId, visitorId, includeVisits) => ({
  ':chat': chatId, ':visitor': visitorId, ':visits': includeVisits ? 1 : 0,
});

export async function conversationNumber(chatId, visitorId, includeVisits, conversationId) {
  const row = await db.get(`SELECT count(*) AS n FROM conversations v JOIN contacts c ON c.id = v.contact_id
    WHERE v.id <= :id AND (c.owner_chat_id = :chat OR (:visits = 1 AND v.visitor_id = :visitor))`, {
    ...numberParams(chatId, visitorId, includeVisits), ':id': conversationId,
  });
  return row?.n || 0;
}

export const conversationByNumber = (chatId, visitorId, includeVisits, number) => db.get(`${conversationSelect}
  WHERE v.id = (SELECT v2.id FROM conversations v2 JOIN contacts c2 ON c2.id = v2.contact_id
    WHERE c2.owner_chat_id = :chat OR (:visits = 1 AND v2.visitor_id = :visitor)
    ORDER BY v2.id LIMIT 1 OFFSET :index)`, {
  ...numberParams(chatId, visitorId, includeVisits), ':index': number - 1,
});

export async function openConversation(contact, visitorId) {
  const time = now();
  await db.run(`INSERT INTO conversations (contact_id, visitor_id, generation, created_at, updated_at)
    SELECT c.id, :visitor, c.generation, :time, :time FROM contacts c
    WHERE c.id = :contact AND c.enabled = 1 AND c.deleted = 0 AND c.generation = :generation
    AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.owner_chat_id = c.owner_chat_id AND b.visitor_id = :visitor)
    ON CONFLICT(contact_id, visitor_id, generation) DO NOTHING`, {
    ':contact': contact.id, ':visitor': visitorId, ':generation': contact.generation, ':time': time,
  });
  return db.get(`${conversationSelect} WHERE v.contact_id = :contact AND v.visitor_id = :visitor AND v.generation = :generation`, {
    ':contact': contact.id, ':visitor': visitorId, ':generation': contact.generation,
  });
}

export const listConversations = (chatId, visitorId, includeVisits, offset = 0) => db.all(`${conversationSelect}
  WHERE c.deleted = 0 AND (c.owner_chat_id = :chat OR (:visits = 1 AND v.visitor_id = :visitor))
  ORDER BY v.updated_at DESC, v.id DESC LIMIT :limit OFFSET :offset`, {
  ':chat': chatId, ':visitor': visitorId, ':visits': includeVisits ? 1 : 0, ':limit': LIMITS.pageSize + 1, ':offset': offset,
});

export async function setConversationState(id, status, visitorMuted = null) {
  const extra = visitorMuted === null ? '' : ', visitor_muted = :muted';
  const params = { ':id': id, ':status': status, ':time': now() };
  if (visitorMuted !== null) params[':muted'] = visitorMuted;
  await db.run(`UPDATE conversations SET status = :status, updated_at = :time${extra} WHERE id = :id`, params);
}

export const isBlocked = async (chatId, visitorId) => !!await db.get('SELECT id FROM blocks WHERE owner_chat_id = :chat AND visitor_id = :visitor', { ':chat': chatId, ':visitor': visitorId });
export async function blockConversation(id, chatId, actorId) {
  await db.run(`INSERT INTO blocks (owner_chat_id, visitor_id, conversation_id, created_by, created_at)
    SELECT c.owner_chat_id, v.visitor_id, v.id, :actor, :time FROM conversations v JOIN contacts c ON c.id = v.contact_id
    WHERE v.id = :id AND c.owner_chat_id = :chat AND c.deleted = 0
    ON CONFLICT(owner_chat_id, visitor_id) DO NOTHING`, { ':id': id, ':chat': chatId, ':actor': actorId, ':time': now() });
}
export const unblockConversation = (id, chatId) => db.run(`DELETE FROM blocks WHERE owner_chat_id = :chat AND visitor_id =
  (SELECT v.visitor_id FROM conversations v JOIN contacts c ON c.id = v.contact_id WHERE v.id = :id AND c.owner_chat_id = :chat)`, { ':chat': chatId, ':id': id });
export const listBlocks = (chatId, offset = 0) => db.all('SELECT * FROM blocks WHERE owner_chat_id = :chat ORDER BY id DESC LIMIT :limit OFFSET :offset', {
  ':chat': chatId, ':limit': LIMITS.pageSize + 1, ':offset': offset,
});
export const unblockById = (id, chatId) => db.run('DELETE FROM blocks WHERE id = :id AND owner_chat_id = :chat', { ':id': id, ':chat': chatId });

export async function setSession(chatId, userId, kind, refId = 0, promptId = 0, topicId = 0) {
  await db.run(`INSERT INTO sessions (key, chat_id, user_id, kind, ref_id, prompt_id, topic_id, expires_at)
    VALUES (:key, :chat, :user, :kind, :ref, :prompt, :topic, :expiry)
    ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, ref_id = excluded.ref_id, prompt_id = excluded.prompt_id,
      topic_id = excluded.topic_id, expires_at = excluded.expires_at`, {
    ':key': sessionKey(chatId, userId), ':chat': chatId, ':user': userId, ':kind': kind,
    ':ref': refId, ':prompt': promptId, ':topic': topicId, ':expiry': now() + LIMITS.sessionMs,
  });
}
export const getSession = (chatId, userId) => db.get('SELECT * FROM sessions WHERE key = :key AND expires_at > :time', { ':key': sessionKey(chatId, userId), ':time': now() });
export const clearSession = (chatId, userId) => db.run('DELETE FROM sessions WHERE key = :key', { ':key': sessionKey(chatId, userId) });
export const clearSessionIfPrompt = (chatId, userId, promptId) => db.run('DELETE FROM sessions WHERE key = :key AND prompt_id = :prompt', {
  ':key': sessionKey(chatId, userId), ':prompt': promptId,
});

export async function saveRoute(chatId, messageId, topicId, conversationId, side) {
  await db.run(`INSERT INTO reply_routes (key, chat_id, message_id, topic_id, conversation_id, side, expires_at)
    VALUES (:key, :chat, :message, :topic, :conversation, :side, :expiry)
    ON CONFLICT(key) DO UPDATE SET topic_id = excluded.topic_id, conversation_id = excluded.conversation_id, side = excluded.side, expires_at = excluded.expires_at`, {
    ':key': `${chatId}:${messageId}`, ':chat': chatId, ':message': messageId, ':topic': topicId,
    ':conversation': conversationId, ':side': side, ':expiry': now() + LIMITS.routeMs,
  });
}
export const getRoute = (chatId, messageId) => db.get('SELECT * FROM reply_routes WHERE key = :key AND expires_at > :time', {
  ':key': `${chatId}:${messageId}`, ':time': now(),
});

export const getDelivery = (key) => db.get('SELECT * FROM deliveries WHERE key = :key', { ':key': key });
export async function reserveDelivery(key, conversation, direction, targetChatId) {
  return one(`INSERT INTO deliveries (key, conversation_id, direction, target_chat_id, status, created_at, expires_at)
    SELECT :key, v.id, :direction, :target, 'sending', :time, :expiry FROM conversations v JOIN contacts c ON c.id = v.contact_id
    WHERE v.id = :id AND c.enabled = 1 AND c.deleted = 0 AND v.generation = c.generation
      AND v.status = 'open' AND v.visitor_muted = 0
      AND NOT EXISTS (SELECT 1 FROM settings s WHERE s.key = 'migration_lock:' || c.owner_chat_id)
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.owner_chat_id = c.owner_chat_id AND b.visitor_id = v.visitor_id)
    ON CONFLICT(key) DO NOTHING RETURNING key`, {
    ':key': key, ':id': conversation.id, ':direction': direction, ':target': targetChatId, ':time': now(), ':expiry': now() + LIMITS.routeMs,
  });
}
export async function finishDelivery(key, status, messageId = 0) {
  await db.run('UPDATE deliveries SET status = :status, message_id = :message WHERE key = :key', { ':status': status, ':message': messageId, ':key': key });
}
export async function touchConversation(id) {
  await db.run('UPDATE conversations SET updated_at = :time WHERE id = :id', { ':time': now(), ':id': id });
}

export async function disableChat(chatId) {
  await db.run('UPDATE contacts SET enabled = 0, updated_at = :time WHERE owner_chat_id = :chat AND deleted = 0', { ':chat': chatId, ':time': now() });
}

export async function migrateChat(oldId, newId) {
  if (oldId === newId || oldId >= 0 || newId >= 0 || !Number.isSafeInteger(oldId) || !Number.isSafeInteger(newId)) return;
  const previous = await getSetting(`migration:${oldId}`);
  if (previous?.value === String(newId) && !await getSetting(`migration_lock:${oldId}`) && !await getSetting(`migration_lock:${newId}`)) return;
  // SDK не обещает транзакций. Пока переносим связанные строки, reserveDelivery
  // атомарно запрещает новые отправки обеим версиям чата. Повтор продолжает перенос.
  const lock = `${oldId}:${newId}`;
  await db.run(`INSERT INTO settings (key, value) VALUES (:old, :lock), (:new, :lock)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`, {
    ':old': `migration_lock:${oldId}`, ':new': `migration_lock:${newId}`, ':lock': lock,
  });
  const copyBlocks = () => db.run(`INSERT INTO blocks (owner_chat_id, visitor_id, conversation_id, created_by, created_at)
    SELECT :new, visitor_id, conversation_id, created_by, created_at FROM blocks WHERE owner_chat_id = :old
    ON CONFLICT(owner_chat_id, visitor_id) DO NOTHING`, { ':new': newId, ':old': oldId });
  await copyBlocks();
  await db.run("UPDATE contacts SET owner_chat_id = :new, owner_kind = 'group', topic_id = 0 WHERE owner_chat_id = :old", { ':new': newId, ':old': oldId });
  // Добираем блокировки, добавленные параллельно перед переносом карточки.
  await copyBlocks();
  await db.run('DELETE FROM blocks WHERE owner_chat_id = :old', { ':old': oldId });
  // Старые message_id не привязываем к новой группе: они не являются глобальными ID.
  await db.run('DELETE FROM reply_routes WHERE chat_id = :old', { ':old': oldId });
  await db.run('DELETE FROM sessions WHERE chat_id = :old', { ':old': oldId });
  await setSetting(`migration:${oldId}`, newId);
  await db.run('DELETE FROM settings WHERE (key = :old OR key = :new) AND value = :lock', {
    ':old': `migration_lock:${oldId}`, ':new': `migration_lock:${newId}`, ':lock': lock,
  });
}

export async function sweepExpired() {
  const time = now();
  const lease = await one(`INSERT INTO settings (key, value) VALUES ('cleanup_at', :time)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(settings.value AS INTEGER) < :before RETURNING key`, {
    ':time': String(time), ':before': time - 60 * 60 * 1000,
  });
  if (!lease) return;
  // Ограниченные порции, без таймера и долгой фоновой задачи. Просроченные записи уже не действуют.
  for (const table of ['sessions', 'reply_routes', 'processed_events', 'deliveries', 'rate_limits']) {
    await db.run(`DELETE FROM ${table} WHERE key IN (SELECT key FROM ${table} WHERE expires_at < :time LIMIT 200)`, { ':time': time });
  }
}
