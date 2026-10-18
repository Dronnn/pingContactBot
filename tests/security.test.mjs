import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { onMessage, onCallback, onMyChatMember } from '../tgcloud/lib/app.js';
import * as store from '../tgcloud/lib/store.js';
import { reset, apiCalls, db, setMember, failNext } from './fake-sdk.mjs';

const BOT = { id: 999, is_bot: true, first_name: 'Contact Bot', username: 'test_contact_bot' };
const OWNER = 101;
const VISITOR = 202;
const STRANGER = 303;
const ADMIN = 401;
const MEMBER = 402;
const GROUP = -100100;
const OTHER_GROUP = -100200;
let sequence;

beforeEach(async () => {
  await reset({ bot: BOT });
  sequence = 1000;
  setMember(GROUP, ADMIN, 'administrator');
  setMember(GROUP, MEMBER, 'member');
  setMember(OTHER_GROUP, MEMBER, 'member');
});

const user = (id) => ({ id, is_bot: false, first_name: `Private name ${id}`, username: `private_profile_${id}` });
const chat = (id) => ({ id, type: id < 0 ? 'supergroup' : 'private', ...(id < 0 ? { title: 'Private group title' } : {}) });

function message(chatId, userId, text, { id = ++sequence, topic = 0, reply, ...extra } = {}) {
  return {
    message_id: id, date: Math.floor(Date.now() / 1000), chat: chat(chatId), from: user(userId), text,
    ...(topic ? { message_thread_id: topic, is_topic_message: true } : {}),
    ...(reply !== undefined ? { reply_to_message: typeof reply === 'number'
      ? { message_id: reply, from: BOT, chat: chat(chatId) } : reply } : {}),
    ...extra,
  };
}

function callback(chatId, userId, data, { id = `query-${++sequence}`, topic = 0, messageId = 800, ...extra } = {}) {
  return { id, from: user(userId), data, message: message(chatId, BOT.id, 'Bot controls', {
    id: messageId, topic, from: BOT,
  }), ...extra };
}

const click = (chatId, userId, data, options) => onCallback(callback(chatId, userId, data, options));
const outboundTo = (id) => apiCalls.filter(({ method, payload }) => /^(send|copy|forward)/.test(method) && payload.chat_id === id);
const textsTo = (id) => outboundTo(id).map(({ payload }) => payload.text ?? payload.caption ?? '');
const clearCalls = () => { apiCalls.length = 0; };

async function fixture({ owner = OWNER, visitor = VISITOR, topic = 0, title = 'A bicycle' } = {}) {
  const contact = await store.createContact({
    chatId: owner, kind: owner < 0 ? 'group' : 'private', title,
    token: (++sequence).toString(16).padStart(48, '0'), topicId: topic,
    userId: owner < 0 ? ADMIN : owner, eventKey: `fixture-${sequence}`,
  });
  const conversation = await store.openConversation(contact, visitor);
  assert.ok(contact && conversation, 'security fixture must contain an open conversation');
  return { contact, conversation };
}

async function expectNoDelivery(remoteChat, operation) {
  clearCalls();
  await operation();
  assert.deepEqual(outboundTo(remoteChat), [], `must not send anything to chat ${remoteChat}`);
}

test('a current group member can reply, while generated delivery exposes no profile metadata', async () => {
  const { conversation } = await fixture({ owner: GROUP, topic: 17 });
  await store.saveRoute(GROUP, 501, 17, conversation.id, 'owner');
  const text = 'I will move the bicycle now.';
  await onMessage(message(GROUP, MEMBER, text, {
    topic: 17, reply: 501,
    author_signature: 'Private signature',
    forward_origin: { type: 'user', sender_user: user(STRANGER), date: 1 },
    entities: [{ type: 'text_mention', offset: 0, length: 1, user: user(STRANGER) }],
  }));
  const delivered = outboundTo(VISITOR);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].method, 'sendMessage');
  assert.ok(delivered[0].payload.text.endsWith(text));
  assert.ok(textsTo(GROUP).some(value => value.includes('Ответ отправлен')));
  assert.doesNotMatch(JSON.stringify(delivered[0].payload), /private_profile_|Private name|Private signature|Private group title/);
  for (const key of ['entities', 'forward_origin', 'author_signature', 'from']) {
    assert.equal(Object.hasOwn(delivered[0].payload, key), false);
  }
});

test('another private user cannot read or manage a personal or group card by its numeric ID', async () => {
  for (const owner of [OWNER, GROUP]) {
    const { contact, conversation } = await fixture({ owner });
    for (const action of [
      `card:${contact.id}`, `rename:${contact.id}`, `description:${contact.id}`,
      `disable:${contact.id}`, `enable:${contact.id}`, `rotate:${contact.id}:1`,
      `delete:${contact.id}`, `qr:${contact.id}`, `dialog:${conversation.id}`, `block:${conversation.id}`,
    ]) {
      await expectNoDelivery(owner, () => click(STRANGER, STRANGER, action));
      assert.deepEqual(await store.getContact(contact.id), contact, action);
      assert.equal(await store.isBlocked(owner, VISITOR), false);
      assert.ok(textsTo(STRANGER).some(value => value.includes('недоступен')), action);
      assert.ok(textsTo(STRANGER).every(value => !value.includes(contact.token)), 'do not leak the contact link');
    }
  }
});

test('a private chat ID does not grant owner privileges to a different actor', async () => {
  const { contact } = await fixture();
  await click(OWNER, STRANGER, `disable:${contact.id}`);
  await onMessage(message(OWNER, STRANGER, '/new Hijacked card'));
  assert.equal((await store.getContact(contact.id)).enabled, 1);
  assert.equal((await store.listContacts(OWNER)).length, 1);
  assert.ok(textsTo(OWNER).every(value => !value.includes('Hijacked card')));
  assert.deepEqual(outboundTo(VISITOR), []);
});

for (const [label, status] of [
  ['regular member', 'member'], ['former member', 'left'], ['banned member', 'kicked'],
  ['restricted non-member', { status: 'restricted', is_member: false, can_send_messages: true }],
]) {
  test(`${label} cannot manage group cards or blocks through old controls`, async () => {
    const { contact, conversation } = await fixture({ owner: GROUP });
    setMember(GROUP, MEMBER, status);
    for (const action of [`disable:${contact.id}`, `rename:${contact.id}`, `rotate:${contact.id}:1`, `delete:${contact.id}`, `block:${conversation.id}`, `close:${conversation.id}`]) {
      await expectNoDelivery(VISITOR, () => click(GROUP, MEMBER, action));
      assert.deepEqual(await store.getContact(contact.id), contact, action);
      assert.equal(await store.isBlocked(GROUP, VISITOR), false);
      assert.equal((await store.getConversation(conversation.id)).status, 'open');
    }
    await onMessage(message(GROUP, MEMBER, '/new Unauthorized group card'));
    assert.equal((await store.listContacts(GROUP)).length, 1);
    assert.equal(apiCalls.some(call => call.method === 'sendPhoto'), false);
  });
}

for (const mode of ['rename', 'new']) {
  test(`administrator demoted after a ${mode} prompt cannot finish the operation`, async () => {
    const { contact } = await fixture({ owner: GROUP, topic: 17 });
    await click(GROUP, ADMIN, mode === 'new' ? 'new' : `rename:${contact.id}`, { topic: 17 });
    const pending = await store.getSession(GROUP, ADMIN);
    assert.equal(pending?.kind, mode, 'an actual permitted prompt must have been created');
    assert.ok(pending.prompt_id > 0);
    setMember(GROUP, ADMIN, 'member');
    clearCalls();
    await onMessage(message(GROUP, ADMIN, 'Unauthorized new title', { topic: 17, reply: pending.prompt_id }));
    assert.equal((await store.listContacts(GROUP)).length, 1);
    assert.equal((await store.getContact(contact.id)).title, contact.title);
    assert.ok(textsTo(GROUP).some(value => value.includes('администраторы')));
    assert.deepEqual(outboundTo(VISITOR), []);
    assert.equal(apiCalls.some(call => call.method === 'sendPhoto'), false);
  });
}

test('a member who leaves after opening Reply cannot send the pending answer', async () => {
  const { conversation } = await fixture({ owner: GROUP, topic: 17 });
  await click(GROUP, MEMBER, `reply:${conversation.id}`, { topic: 17 });
  const pending = await store.getSession(GROUP, MEMBER);
  assert.equal(pending?.kind, 'reply_owner');
  setMember(GROUP, MEMBER, 'left');
  await expectNoDelivery(VISITOR, () => onMessage(message(GROUP, MEMBER, 'Former member answer', {
    topic: 17, reply: pending.prompt_id,
  })));
  assert.ok(textsTo(GROUP).some(value => value.includes('участникам группы')));
});

test('another administrator cannot consume a prompt opened by its original actor', async () => {
  const { contact } = await fixture({ owner: GROUP });
  setMember(GROUP, MEMBER, 'administrator');
  await click(GROUP, ADMIN, `rename:${contact.id}`);
  const pending = await store.getSession(GROUP, ADMIN);
  await onMessage(message(GROUP, MEMBER, 'Wrong actor title', { reply: pending.prompt_id }));
  assert.equal((await store.getContact(contact.id)).title, contact.title);
  await onMessage(message(GROUP, ADMIN, 'Correct actor title', { reply: pending.prompt_id }));
  assert.equal((await store.getContact(contact.id)).title, 'Correct actor title');
  assert.ok(textsTo(GROUP).some(value => value.includes('Correct actor title')));
});

test('sender_chat never borrows privileges from a fake or apparently privileged from field', async () => {
  const { contact, conversation } = await fixture({ owner: GROUP });
  await store.saveRoute(GROUP, 501, 0, conversation.id, 'owner');
  for (const sender of [{ id: GROUP, type: 'supergroup' }, { id: OTHER_GROUP, type: 'channel' }]) {
    await onMessage(message(GROUP, ADMIN, '/new Anonymous card', { sender_chat: sender }));
    await expectNoDelivery(VISITOR, () => onMessage(message(GROUP, ADMIN, 'Anonymous owner answer', {
      sender_chat: sender, reply: 501,
    })));
    assert.ok(textsTo(GROUP).some(value => value.includes('от своего аккаунта')));
    assert.equal((await store.listContacts(GROUP)).length, 1);
    assert.deepEqual(await store.getContact(contact.id), contact);
  }
});

test('ordinary group conversation and replies in another chat or topic are not relayed', async () => {
  const { conversation } = await fixture({ owner: GROUP, topic: 17 });
  await store.saveRoute(GROUP, 501, 17, conversation.id, 'owner');
  await store.setSession(GROUP, MEMBER, 'reply_owner', conversation.id, 701, 17);
  const attempts = [
    message(GROUP, MEMBER, 'Ordinary group chatter', { topic: 17 }),
    message(OTHER_GROUP, MEMBER, 'Same message ID in another chat', { topic: 17, reply: 501 }),
    message(GROUP, MEMBER, 'Wrong topic route', { topic: 18, reply: 501 }),
    message(GROUP, MEMBER, 'Wrong topic prompt', { topic: 18, reply: 701 }),
    message(GROUP, MEMBER, 'Reply to another person', { topic: 17, reply: { message_id: 900, from: user(ADMIN) } }),
    message(GROUP, MEMBER, 'External reply is not a route', {
      topic: 17, external_reply: { chat: chat(OTHER_GROUP), message_id: 501 },
    }),
  ];
  for (const attempt of attempts) await expectNoDelivery(VISITOR, () => onMessage(attempt));
  clearCalls();
  await onMessage(message(GROUP, MEMBER, 'Correct explicit reply', { topic: 17, reply: 501 }));
  assert.equal(outboundTo(VISITOR).length, 1, 'the correct route remains usable');
  assert.ok(textsTo(VISITOR)[0].endsWith('Correct explicit reply'));
});

for (const state of ['disabled', 'blocked', 'rotated']) {
  test(`${state} contact rejects active visits, old replies, commands and pending forms`, async () => {
    const { contact, conversation } = await fixture();
    await store.setSession(VISITOR, VISITOR, 'visit', conversation.id);
    await store.saveRoute(OWNER, 501, 0, conversation.id, 'owner');
    await store.saveRoute(VISITOR, 601, 0, conversation.id, 'visitor');
    const action = state === 'disabled' ? `disable:${contact.id}`
      : state === 'blocked' ? `block:${conversation.id}` : `rotate:${contact.id}:1`;
    await click(OWNER, OWNER, action);
    const current = await store.getContact(contact.id);
    assert.ok(state === 'disabled' ? current.enabled === 0
      : state === 'blocked' ? await store.isBlocked(OWNER, VISITOR) : current.generation === 2);
    // Simulate a stale prompt that survived an overlapping UI request. Refusal
    // must depend on current access, even when session cleanup lost a race.
    await store.setSession(OWNER, OWNER, 'reply_owner', conversation.id, 701);
    for (const [remote, attempt] of [
      [OWNER, message(VISITOR, VISITOR, 'Active visitor session must stop')],
      [VISITOR, message(OWNER, OWNER, 'Old owner reply must stop', { reply: 501 })],
      [OWNER, message(VISITOR, VISITOR, 'Old visitor reply must stop', { reply: 601 })],
      [VISITOR, message(OWNER, OWNER, `/reply ${conversation.id} Direct reply must stop`)],
      [VISITOR, message(OWNER, OWNER, 'Pending owner form must stop', { reply: 701 })],
    ]) {
      await expectNoDelivery(remote, () => onMessage(attempt));
      assert.ok(textsTo(attempt.chat.id).some(value => value.includes('недоступен')),
        `${attempt.text}: ${JSON.stringify(textsTo(attempt.chat.id))}`);
    }
    await expectNoDelivery(VISITOR, () => click(OWNER, OWNER, `reply:${conversation.id}`));
    await expectNoDelivery(OWNER, () => click(VISITOR, VISITOR, `reply:${conversation.id}`));
    await expectNoDelivery(OWNER, () => onMessage(message(VISITOR, VISITOR, `/start c_${contact.token}`)));
    assert.equal((await db.all('SELECT * FROM deliveries')).length, 0);
  });
}

test('a visitor who disabled replies cannot be reopened or contacted by the owner', async () => {
  const { conversation } = await fixture();
  await store.saveRoute(OWNER, 501, 0, conversation.id, 'owner');
  await store.setSession(OWNER, OWNER, 'reply_owner', conversation.id, 701);
  await click(VISITOR, VISITOR, `close:${conversation.id}`);
  assert.equal((await store.getConversation(conversation.id)).visitor_muted, 1);
  await expectNoDelivery(VISITOR, () => click(OWNER, OWNER, `reopen:${conversation.id}`));
  assert.ok(textsTo(OWNER).some(value => value.includes('Возобновить диалог может только он')));
  for (const attempt of [
    message(OWNER, OWNER, `/reply ${conversation.id} Unwanted command reply`),
    message(OWNER, OWNER, 'Unwanted old reply', { reply: 501 }),
    message(OWNER, OWNER, 'Unwanted pending answer', { reply: 701 }),
  ]) await expectNoDelivery(VISITOR, () => onMessage(attempt));
  await expectNoDelivery(VISITOR, () => click(OWNER, OWNER, `reply:${conversation.id}`));
  const closed = await store.getConversation(conversation.id);
  assert.equal(closed.status, 'closed');
  assert.equal(closed.visitor_muted, 1);

  await click(VISITOR, VISITOR, `reopen:${conversation.id}`);
  const reopened = await store.getConversation(conversation.id);
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.visitor_muted, 0);
  clearCalls();
  await onMessage(message(OWNER, OWNER, `/reply ${conversation.id} Reply after consent`));
  assert.equal(outboundTo(VISITOR).length, 1);
  assert.ok(textsTo(VISITOR)[0].endsWith('Reply after consent'));
});

test('duplicate incoming message processing sends one remote message, even concurrently', async () => {
  const { conversation } = await fixture();
  await store.setSession(VISITOR, VISITOR, 'visit', conversation.id);
  const update = message(VISITOR, VISITOR, 'One unique parking notice');
  await Promise.all([onMessage(update), onMessage(structuredClone(update))]);
  await onMessage(structuredClone(update));
  assert.equal(outboundTo(OWNER).length, 1);
  assert.ok(textsTo(OWNER)[0].endsWith('One unique parking notice'));
  const deliveries = await db.all('SELECT * FROM deliveries');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].status, 'sent');
});

test('repeated disable callbacks set a state and never toggle the card back on', async () => {
  const { contact } = await fixture();
  const update = callback(OWNER, OWNER, `disable:${contact.id}`);
  await Promise.all([onCallback(update), onCallback(structuredClone(update))]);
  await click(OWNER, OWNER, `disable:${contact.id}`);
  assert.equal((await store.getContact(contact.id)).enabled, 0);
  assert.equal((await store.getContact(contact.id)).generation, 1);
  assert.deepEqual(outboundTo(VISITOR), []);
  assert.ok(textsTo(OWNER).every(value => value.includes('отключён')));
});

test('one rotation confirmation cannot rotate again under duplicate or separate callback IDs', async () => {
  const { contact } = await fixture();
  await click(OWNER, OWNER, `askrotate:${contact.id}`);
  const confirmation = outboundTo(OWNER).flatMap(call => call.payload.reply_markup?.inline_keyboard?.flat() ?? [])
    .find(button => button.callback_data?.startsWith('rotate:'));
  assert.ok(confirmation, 'use a confirmation issued by the actual UI');
  clearCalls();
  const first = callback(OWNER, OWNER, confirmation.callback_data);
  await Promise.all([onCallback(first), onCallback(structuredClone(first))]);
  const rotated = await store.getContact(contact.id);
  assert.equal(rotated.generation, 2);
  assert.notEqual(rotated.token, contact.token);
  await Promise.all([
    click(OWNER, OWNER, confirmation.callback_data),
    click(OWNER, OWNER, confirmation.callback_data),
  ]);
  const final = await store.getContact(contact.id);
  assert.equal(final.generation, 2);
  assert.equal(final.token, rotated.token);
  assert.deepEqual(outboundTo(VISITOR), []);
  assert.ok(textsTo(OWNER).some(value => value.includes('уже была заменена')));
  assert.ok(textsTo(OWNER).filter(value => value.includes('https://t.me/')).every(value => value.includes(rotated.token)));
});

test('membership API failures deny management instead of assuming administrator privileges', async () => {
  const { contact } = await fixture({ owner: GROUP });
  failNext('getChatMember', { error_code: 500, description: 'Membership service unavailable' });
  await click(GROUP, ADMIN, `disable:${contact.id}`);
  assert.deepEqual(await store.getContact(contact.id), contact);
  assert.ok(textsTo(GROUP).some(value => value.includes('Не удалось проверить участие')));
  assert.deepEqual(outboundTo(VISITOR), []);
});

test('replaying a processed demotion after reinstatement and manual enable does not disable cards again', async () => {
  const { contact } = await fixture({ owner: GROUP });
  const update = {
    chat: chat(GROUP), from: user(ADMIN), date: 100,
    old_chat_member: { user: BOT, status: 'administrator' },
    new_chat_member: { user: BOT, status: 'member' },
  };
  setMember(GROUP, BOT.id, 'member');
  await onMyChatMember(update, { update: { update_id: 10001 } });
  assert.equal((await store.getContact(contact.id)).enabled, 0);
  setMember(GROUP, BOT.id, 'administrator');
  await onMyChatMember({ ...update, date: 101, old_chat_member: update.new_chat_member,
    new_chat_member: { user: BOT, status: 'administrator' } }, { update: { update_id: 10002 } });
  await click(GROUP, ADMIN, `enable:${contact.id}`);
  assert.equal((await store.getContact(contact.id)).enabled, 1);
  clearCalls();
  await onMyChatMember(structuredClone(update), { update: { update_id: 10001 } });
  assert.equal((await store.getContact(contact.id)).enabled, 1,
    'a duplicate old membership event must not undo a newer explicit enable');
  assert.deepEqual(outboundTo(VISITOR), []);
});
