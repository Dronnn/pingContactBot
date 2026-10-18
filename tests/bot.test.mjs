import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { reset, apiCalls, db, setMember, failNext, InputFile } from './fake-sdk.mjs';
import { onMessage, onCallback, onMyChatMember } from '../tgcloud/lib/app.js';
import * as store from '../tgcloud/lib/store.js';
import { newToken, parseCommand, contactLink } from '../tgcloud/lib/domain.js';

let sequence = 1000;
const bot = { id: 999, is_bot: true, first_name: 'Contact Bot', username: 'test_contact_bot' };
const user = (id) => ({ id, is_bot: false, first_name: `Person ${id}`, username: `private_username_${id}` });
const chat = (id) => ({ id, type: id < 0 ? 'supergroup' : 'private', ...(id < 0 ? { title: 'Секретное название группы' } : {}) });
function message(id, text, extra = {}) {
  return { message_id: ++sequence, date: 1792310000, chat: chat(id), from: user(id > 0 ? id : 301), text, ...extra };
}
async function say(id, text, extra = {}) {
  const m = message(id, text, extra);
  await onMessage(m, { update: { update_id: sequence } });
  return m;
}
async function click(id, data, actor = id, topic = 0) {
  await onCallback({ id: `q${++sequence}`, from: user(actor), data,
    message: { message_id: 900, date: 1792310000, chat: chat(id), from: bot, ...(topic ? { message_thread_id: topic } : {}) } }, { update: { update_id: sequence } });
}
async function contact(owner = 101, title = 'Моя машина', topic = 0) {
  if (owner < 0) setMember(owner, 301, 'administrator');
  await say(owner, `/new ${title}`, topic ? { message_thread_id: topic } : {});
  return db.get('SELECT * FROM contacts WHERE owner_chat_id = :owner ORDER BY id DESC LIMIT 1', { ':owner': owner });
}
async function visit(c, id = 201) {
  await say(id, `/start c_${c.token}`);
  return db.get('SELECT * FROM conversations WHERE contact_id = :id AND visitor_id = :visitor ORDER BY id DESC LIMIT 1', { ':id': c.id, ':visitor': id });
}
const texts = (id) => apiCalls.filter((call) => call.method === 'sendMessage' && call.payload.chat_id === id).map((call) => call.payload);
const deliveries = (id, prefix = 'По поводу') => texts(id).filter((p) => p.text.startsWith(prefix));
const lastText = (id) => texts(id).at(-1);

beforeEach(async () => { sequence = 1000; await reset(); });

test('создание в личке выдаёт случайную ссылку, карточку и настоящий PNG', async () => {
  const c = await contact();
  assert.equal(c.owner_chat_id, 101);
  assert.match(c.token, /^[a-f0-9]{48}$/);
  assert.ok(lastText(101).text.includes(contactLink(bot.username, c.token)));
  const photo = apiCalls.find((call) => call.method === 'sendPhoto').payload.photo;
  assert.ok(photo instanceof InputFile);
  assert.deepEqual(Array.from(photo.data.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.notEqual(c.token, newToken());
  assert.ok(`c_${c.token}`.length <= 64);
});

test('путь QR → посетитель → владелец → reply → посетитель', async () => {
  const c = await contact();
  const v = await visit(c);
  await say(201, 'Вы перекрыли выезд');
  const incoming = deliveries(101).at(-1);
  assert.match(incoming.text, /Собеседник #1/);
  const route = await db.get("SELECT * FROM reply_routes WHERE side = 'owner'");
  await say(101, 'Выхожу', { reply_to_message: { message_id: route.message_id, from: bot } });
  assert.equal(deliveries(201, 'Ответ по поводу').length, 1);
  assert.ok(deliveries(201, 'Ответ по поводу')[0].text.endsWith('Выхожу'));
  assert.deepEqual((await db.all('SELECT status FROM deliveries')).map((row) => row.status), ['sent', 'sent']);
  assert.equal(v.id, 1);
});

test('групповой контакт отправляет в указанную тему, участник отвечает через ForceReply', async () => {
  const c = await contact(-100, 'Дверь мастерской', 17);
  const v = await visit(c);
  assert.match(lastText(201).text, /увидят участники группы/);
  assert.ok(!lastText(201).text.includes('Секретное название группы'));
  await say(201, 'Я у двери');
  assert.equal(deliveries(-100).at(-1).message_thread_id, 17);
  setMember(-100, 302, 'member');
  await click(-100, `reply:${v.id}`, 302, 17);
  const state = await store.getSession(-100, 302);
  assert.equal(state.kind, 'reply_owner');
  assert.equal(lastText(-100).reply_markup.selective, true);
  assert.equal(lastText(-100).entities[0].user.id, 302);
  await say(-100, 'Сейчас откроем', { from: user(302), message_thread_id: 17, reply_to_message: { message_id: state.prompt_id, from: bot } });
  assert.ok(deliveries(201, 'Ответ по поводу').at(-1).text.endsWith('Сейчас откроем'));
  assert.ok(!JSON.stringify(deliveries(201, 'Ответ по поводу')).includes('302'));
  assert.equal(await store.getSession(-100, 302), null);
});

test('два посетителя одного контакта получают свои ответы', async () => {
  const c = await contact();
  const first = await visit(c, 201);
  const second = await visit(c, 202);
  await say(201, 'Вопрос А');
  await say(202, 'Вопрос Б');
  const routes = await db.all("SELECT * FROM reply_routes WHERE side = 'owner' ORDER BY conversation_id");
  assert.notEqual(routes[0].message_id, routes[1].message_id);
  await say(101, 'Ответ Б', { reply_to_message: { message_id: routes[1].message_id, from: bot } });
  await say(101, 'Ответ А', { reply_to_message: { message_id: routes[0].message_id, from: bot } });
  assert.ok(deliveries(201, 'Ответ по поводу')[0].text.endsWith('Ответ А'));
  assert.ok(deliveries(202, 'Ответ по поводу')[0].text.endsWith('Ответ Б'));
  assert.notEqual(first.id, second.id);
});

test('личная форма создания правильно использует ForceReply и не требует @mention', async () => {
  await say(101, '/new');
  const state = await store.getSession(101, 101);
  assert.equal(lastText(101).reply_markup.selective, false);
  await say(101, 'Рюкзак', { reply_to_message: { message_id: state.prompt_id, from: bot } });
  assert.equal((await db.get('SELECT title FROM contacts')).title, 'Рюкзак');
});

test('создание карточек параллельными администраторами не смешивает формы', async () => {
  setMember(-100, 301, 'administrator');
  setMember(-100, 302, 'administrator');
  await say(-100, '/new', { from: user(301), message_thread_id: 10 });
  await say(-100, '/new', { from: user(302), message_thread_id: 20 });
  const a = await store.getSession(-100, 301);
  const b = await store.getSession(-100, 302);
  await say(-100, 'Дверь Б', { from: user(302), message_thread_id: 20, reply_to_message: { message_id: b.prompt_id, from: bot } });
  await say(-100, 'Дверь А', { from: user(301), message_thread_id: 10, reply_to_message: { message_id: a.prompt_id, from: bot } });
  assert.deepEqual((await db.all('SELECT title, topic_id FROM contacts ORDER BY title')), [{ title: 'Дверь А', topic_id: 10 }, { title: 'Дверь Б', topic_id: 20 }]);
});

test('новые сообщения не содержат metadata профиля, форматирования и forward origin', async () => {
  const c = await contact();
  await visit(c);
  await say(201, '<b>Проверка</b>', { from: { ...user(201), first_name: 'PRIVATE_NAME', username: 'HIDDEN_NAME' },
    entities: [{ type: 'text_mention', offset: 0, length: 1, user: user(301) }], forward_origin: { type: 'user', sender_user: user(501) } });
  const payload = deliveries(101).at(-1);
  assert.ok(payload.text.endsWith('<b>Проверка</b>'));
  assert.equal(payload.parse_mode, undefined);
  assert.equal(payload.entities, undefined);
  assert.equal(payload.link_preview_options.is_disabled, true);
  assert.ok(!JSON.stringify(payload).includes('PRIVATE_NAME'));
  assert.ok(!JSON.stringify(payload).includes('HIDDEN_NAME'));
  assert.ok(!apiCalls.some((call) => /forward|copyMessage/.test(call.method)));
});

test('тексты переписки не сохраняются в SQLite', async () => {
  const c = await contact();
  await visit(c);
  await say(201, 'UNIQUE_PRIVATE_BODY_f309ab');
  const tables = await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence'");
  for (const { name } of tables) assert.ok(!JSON.stringify(await db.all(`SELECT * FROM ${name}`)).includes('UNIQUE_PRIVATE_BODY_f309ab'), name);
});

test('403: нет ложного успеха и повторный update не отправляет сообщение повторно', async () => {
  const c = await contact();
  await visit(c);
  failNext('sendMessage', { error_code: 403, description: 'Forbidden: bot was blocked by the user' });
  const incoming = await say(201, 'Нужно связаться');
  assert.equal((await db.get('SELECT status FROM deliveries')).status, 'failed');
  assert.match(lastText(201).text, /не отправлено/);
  const attemptCount = deliveries(101).length;
  await onMessage(incoming);
  assert.equal(deliveries(101).length, attemptCount);
});

test('сбой сети: неизвестная доставка не повторяется автоматически', async () => {
  const c = await contact();
  await visit(c);
  failNext('sendMessage', new Error('network timeout'));
  const incoming = await say(201, 'Может быть доставлено');
  assert.equal((await db.get('SELECT status FROM deliveries')).status, 'unknown');
  assert.match(lastText(201).text, /могло прийти/);
  await onMessage(incoming);
  assert.equal(deliveries(101).length, 1);
});

test('429 сообщает retry_after и не отключает карточку', async () => {
  const c = await contact();
  await visit(c);
  failNext('sendMessage', { error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 14 } });
  await say(201, 'Проверка частоты');
  assert.match(lastText(201).text, /14 сек/);
  assert.equal((await store.getContact(c.id)).enabled, 1);
});

test('миграция группы сохраняет блокировки, карточки и отзывает старые reply routes', async () => {
  const c = await contact(-100, 'Объявление');
  const v = await visit(c);
  await store.blockConversation(v.id, -100, 301);
  await store.saveRoute(-100, 88, 0, v.id, 'owner');
  await onMessage({ chat: { id: -100, type: 'group' }, message_id: 91, migrate_to_chat_id: -200 });
  await onMessage({ chat: chat(-200), message_id: 92, migrate_from_chat_id: -100 });
  assert.equal((await store.getContact(c.id)).owner_chat_id, -200);
  assert.ok(await store.isBlocked(-200, 201));
  assert.equal(await store.getRoute(-100, 88), null);
  assert.equal(await store.getSetting('migration_lock:-200'), null);
  assert.equal((await db.get('SELECT count(*) AS n FROM blocks')).n, 1);
});

test('незавершённый перенос не разрешает резервирование доставки', async () => {
  const c = await contact(-100);
  const v = await visit(c);
  await store.setSetting('migration_lock:-100', '-100:-200');
  assert.equal(await store.reserveDelivery('attempt', await store.getConversation(v.id), 'to_owner', -100), null);
});

test('setup восстанавливает прерванный перенос группы', async () => {
  const c = await contact(-100);
  setMember(-200, 301, 'administrator');
  await store.setSetting('migration_lock:-100', '-100:-200');
  await store.setSetting('migration_lock:-200', '-100:-200');
  await say(-200, '/setup');
  assert.equal((await store.getContact(c.id)).owner_chat_id, -200);
  assert.equal(await store.getSetting('migration_lock:-100'), null);
  assert.match(lastText(-200).text, /Меню команд обновлено/);
});

test('команда для другого бота не создаёт карточку', async () => {
  await say(101, '/new@another_bot Не наша карточка');
  assert.equal((await db.get('SELECT count(*) AS n FROM contacts')).n, 0);
  assert.equal(texts(101).length, 0);
  assert.deepEqual(parseCommand('/reply@Test_Contact_Bot 12 Привет'), { name: 'reply', username: 'test_contact_bot', args: '12 Привет' });
});

test('истёкшая сессия не отправляет очередной текст', async () => {
  const c = await contact();
  await visit(c);
  await db.run('UPDATE sessions SET expires_at = 1');
  await say(201, 'Кому уйдёт сообщение?');
  assert.equal(deliveries(101).length, 0);
  assert.match(lastText(201).text, /Открой QR/);
});

test('просроченный reply не попадает в другой активный диалог', async () => {
  const c = await contact();
  const v = await visit(c);
  await store.saveRoute(201, 91, 0, v.id, 'visitor');
  await db.run('UPDATE reply_routes SET expires_at = 1');
  await say(201, 'Старый ответ', { reply_to_message: { message_id: 91, from: bot } });
  assert.equal(deliveries(101).length, 0);
  assert.match(lastText(201).text, /больше не связан/);
});

test('вложение и слишком длинный текст не передаются', async () => {
  const c = await contact();
  await visit(c);
  await say(201, undefined, { contact: { phone_number: '+1234567890', first_name: 'Secret' } });
  await say(201, 'x'.repeat(3001));
  assert.equal(deliveries(101).length, 0);
  assert.match(lastText(201).text, /3000/);
});

test('rate limit атомарен при конкурентных вызовах', async () => {
  const allowed = await Promise.all(Array.from({ length: 15 }, () => store.allowRate('concurrency', 4, 60_000)));
  assert.equal(allowed.filter(Boolean).length, 4);
});

test('меню команд устанавливается для личек и групп без чужого токена', async () => {
  await say(101, '/setup');
  const setup = apiCalls.filter((call) => call.method === 'setMyCommands');
  assert.deepEqual(setup.map((call) => call.payload.scope.type), ['all_private_chats', 'all_group_chats']);
  assert.ok(setup[0].payload.commands.some((c) => c.command === 'new'));
  assert.ok(setup[1].payload.commands.some((c) => c.command === 'move'));
});

test('кнопка для печати возвращает PNG-документ', async () => {
  const c = await contact();
  await click(101, `print:${c.id}`);
  const payload = apiCalls.find((call) => call.method === 'sendDocument').payload;
  assert.ok(payload.document instanceof InputFile);
  assert.match(payload.document.filename, /\.png$/);
});

test('можно разблокировать человека после удаления исходной карточки', async () => {
  const c = await contact();
  const v = await visit(c);
  await store.blockConversation(v.id, 101, 101);
  const block = await db.get('SELECT * FROM blocks');
  await click(101, `delete:${c.id}`);
  await click(101, `unblockid:${block.id}`);
  assert.equal((await db.get('SELECT count(*) AS n FROM blocks')).n, 0);
});

test('просмотр своей карточки завершает активный ввод чужому контакту', async () => {
  const own = await contact(201, 'Мой рюкзак');
  const remote = await contact(101, 'Чужая машина');
  await visit(remote, 201);
  await click(201, `card:${own.id}`);
  await say(201, 'Случайный текст после меню');
  assert.equal(deliveries(101).length, 0);
});

test('ответ владельца убирает другой активный диалог посетителя', async () => {
  const own = await contact(101, 'Моя машина');
  const incoming = await visit(own, 202);
  const other = await contact(201, 'Чужая вещь');
  await visit(other, 101);
  await say(101, `/reply ${incoming.id} Ответ на свою карточку`);
  assert.equal(await store.getSession(101, 101), null);
  await say(101, 'Продолжение без явного адресата');
  assert.equal(deliveries(201).length, 0);
});

test('отключение бота в личке выключает публичные контакты владельца', async () => {
  const c = await contact();
  await onMyChatMember({ chat: chat(101), from: user(101), date: 1792310000, new_chat_member: { status: 'kicked', user: bot } }, { update: { update_id: 99 } });
  assert.equal((await store.getContact(c.id)).enabled, 0);
});
