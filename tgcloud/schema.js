import { table, integer, text, index, uniqueIndex } from 'sdk/db';

// Telegram Serverless запрещает foreign keys. Связи и доступ проверяет приложение.
// Все даты — Unix milliseconds. Raw SQL использует те же имена, что эта схема.
export const contacts = table('contacts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  owner_chat_id: integer('owner_chat_id').notNull(),
  owner_kind: text('owner_kind').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  token: text('token').notNull().unique(),
  generation: integer('generation').notNull().default(1),
  enabled: integer('enabled').notNull().default(1),
  deleted: integer('deleted').notNull().default(0),
  topic_id: integer('topic_id').notNull().default(0),
  created_by: integer('created_by').notNull(),
  creation_key: text('creation_key').notNull().unique(),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
}, (t) => ({ owner: index('contacts_owner_idx').on(t.owner_chat_id, t.deleted) }));

export const conversations = table('conversations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  contact_id: integer('contact_id').notNull(),
  visitor_id: integer('visitor_id').notNull(),
  generation: integer('generation').notNull(),
  status: text('status').notNull().default('open'),
  visitor_muted: integer('visitor_muted').notNull().default(0),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
}, (t) => ({
  pair: uniqueIndex('conversations_pair_idx').on(t.contact_id, t.visitor_id, t.generation),
  visitor: index('conversations_visitor_idx').on(t.visitor_id, t.updated_at),
}));

export const blocks = table('blocks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  owner_chat_id: integer('owner_chat_id').notNull(),
  visitor_id: integer('visitor_id').notNull(),
  conversation_id: integer('conversation_id').notNull(),
  created_by: integer('created_by').notNull(),
  created_at: integer('created_at').notNull(),
}, (t) => ({ ownerVisitor: uniqueIndex('blocks_owner_visitor_idx').on(t.owner_chat_id, t.visitor_id) }));

export const sessions = table('sessions', {
  key: text('key').primaryKey(),
  chat_id: integer('chat_id').notNull(),
  user_id: integer('user_id').notNull(),
  kind: text('kind').notNull(),
  ref_id: integer('ref_id').notNull().default(0),
  prompt_id: integer('prompt_id').notNull().default(0),
  topic_id: integer('topic_id').notNull().default(0),
  expires_at: integer('expires_at').notNull(),
}, (t) => ({ expiry: index('sessions_expiry_idx').on(t.expires_at) }));

export const reply_routes = table('reply_routes', {
  key: text('key').primaryKey(),
  chat_id: integer('chat_id').notNull(),
  message_id: integer('message_id').notNull(),
  topic_id: integer('topic_id').notNull().default(0),
  conversation_id: integer('conversation_id').notNull(),
  side: text('side').notNull(),
  expires_at: integer('expires_at').notNull(),
}, (t) => ({ expiry: index('reply_routes_expiry_idx').on(t.expires_at) }));

export const processed_events = table('processed_events', {
  key: text('key').primaryKey(),
  expires_at: integer('expires_at').notNull(),
}, (t) => ({ expiry: index('processed_events_expiry_idx').on(t.expires_at) }));

// Только метаданные доставки. Текст переписки в БД не сохраняется.
export const deliveries = table('deliveries', {
  key: text('key').primaryKey(),
  conversation_id: integer('conversation_id').notNull(),
  direction: text('direction').notNull(),
  target_chat_id: integer('target_chat_id').notNull(),
  status: text('status').notNull(),
  message_id: integer('message_id').notNull().default(0),
  created_at: integer('created_at').notNull(),
  expires_at: integer('expires_at').notNull(),
}, (t) => ({ expiry: index('deliveries_expiry_idx').on(t.expires_at) }));

export const rate_limits = table('rate_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  expires_at: integer('expires_at').notNull(),
}, (t) => ({ expiry: index('rate_limits_expiry_idx').on(t.expires_at) }));

export const settings = table('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
