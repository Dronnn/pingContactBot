import { DatabaseSync } from 'node:sqlite';

// The same module implements sdk and sdk/db. The loader redirects both imports.
const COLUMN = Symbol('column');
const TABLE = Symbol('table');
const INDEX = Symbol('index');

function column(type, name) {
  const descriptor = { type, name, notNull: false, unique: false, primaryKey: false };
  return {
    [COLUMN]: descriptor,
    notNull() { descriptor.notNull = true; return this; },
    unique() { descriptor.unique = true; return this; },
    default(value) { descriptor.defaultValue = value; descriptor.hasDefault = true; return this; },
    primaryKey(options = false) {
      descriptor.primaryKey = true;
      descriptor.notNull = true;
      descriptor.autoIncrement = typeof options === 'object'
        ? options?.autoIncrement === true : options === true;
      return this;
    },
  };
}

export const integer = (name) => column('INTEGER', name);
export const text = (name) => column('TEXT', name);

function makeIndex(name, unique) {
  const descriptor = { name, unique, columns: [] };
  return {
    [INDEX]: descriptor,
    on(...columns) { descriptor.columns = columns.flat(); return this; },
  };
}

export const index = (name) => makeIndex(name, false);
export const uniqueIndex = (name) => makeIndex(name, true);

function collect(value, symbol, result = [], seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return result;
  seen.add(value);
  if (value[symbol]) result.push(value[symbol]);
  else for (const child of Object.values(value)) collect(child, symbol, result, seen);
  return result;
}

export function table(name, columns, extra) {
  for (const [key, value] of Object.entries(columns)) {
    if (!value?.[COLUMN]) throw new TypeError(`Invalid column ${name}.${key}`);
    value[COLUMN].name ??= key;
  }
  const result = { ...columns };
  result[TABLE] = { name, columns, indexes: collect(typeof extra === 'function' ? extra(result) : extra, INDEX) };
  return result;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sqlLiteral(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  throw new TypeError(`Unsupported schema default: ${String(value)}`);
}

let connection;

function requireDb() {
  if (!connection) throw new Error('Call await reset() before using the fake SDK database.');
  return connection;
}

const plainRow = (row) => row == null ? null : { ...row };

export const db = {
  async run(sql, parameters = {}) {
    const database = requireDb();
    const statement = database.prepare(sql);
    if (statement.columns().length > 0) {
      const rows = statement.all(parameters).map(plainRow);
      const info = database.prepare('SELECT changes() AS changes, last_insert_rowid() AS rowid').get();
      return { rowsAffected: Number(info.changes), lastInsertRowid: info.rowid, rows };
    }
    const info = statement.run(parameters);
    return { rowsAffected: Number(info.changes), lastInsertRowid: info.lastInsertRowid, rows: [] };
  },
  async get(sql, parameters = {}) {
    return plainRow(requireDb().prepare(sql).get(parameters));
  },
  async all(sql, parameters = {}) {
    return requireDb().prepare(sql).all(parameters).map(plainRow);
  },
};

export class InputFile {
  constructor(data, filename) {
    this.data = data;
    this.filename = filename;
  }
}

const defaultBot = { id: 999, is_bot: true, first_name: 'Contact Bot', username: 'test_contact_bot', can_join_groups: true, can_read_all_group_messages: true };
let currentBot = { ...defaultBot };
const members = new Map();
const failureQueues = new Map();
const nextMessageIds = new Map();
export const apiCalls = [];

const memberKey = (chatId, userId) => `${chatId}:${userId}`;

export function setMember(chatId, userId, statusOrMember) {
  const details = typeof statusOrMember === 'string' ? { status: statusOrMember } : statusOrMember;
  if (!details?.status) throw new TypeError('setMember requires a status string or ChatMember object.');
  const user = Number(userId) === currentBot.id
    ? { ...currentBot } : { id: Number(userId), is_bot: false, first_name: `User ${userId}` };
  const result = { user, ...details };
  if (result.status === 'administrator' || result.status === 'creator') result.is_anonymous ??= false;
  if (result.status === 'administrator') result.can_manage_chat ??= true;
  members.set(memberKey(chatId, userId), result);
  return result;
}

export function failNext(method, error = { error_code: 500, description: 'Injected API failure' }) {
  const queue = failureQueues.get(method) ?? [];
  queue.push(error);
  failureQueues.set(method, queue);
}

function apiError(value) {
  const error = value instanceof Error ? value : new Error(value.description ?? value.message ?? 'Injected API failure');
  if (!(value instanceof Error)) Object.assign(error, value);
  error.code ??= error.error_code ?? 500;
  error.error_code ??= error.code;
  error.description ??= error.message;
  return error;
}

function chat(chatId) {
  const id = typeof chatId === 'string' && /^-?\d+$/.test(chatId) ? Number(chatId) : chatId;
  return Number(id) < 0 ? { id, type: 'supergroup', title: `Group ${id}` } : { id, type: 'private' };
}

function sentMessage(payload, method) {
  const key = String(payload.chat_id);
  const messageId = payload.message_id ?? (nextMessageIds.get(key) ?? 1);
  if (payload.message_id == null) nextMessageIds.set(key, messageId + 1);
  const result = { message_id: messageId, from: { ...currentBot }, date: Math.floor(Date.now() / 1000), chat: chat(payload.chat_id) };
  for (const field of ['text', 'caption', 'reply_markup', 'message_thread_id', 'entities', 'caption_entities']) {
    if (payload[field] !== undefined) result[field] = payload[field];
  }
  if (method === 'sendPhoto') result.photo = [{ file_id: typeof payload.photo === 'string' ? payload.photo : `photo_${messageId}`, file_unique_id: `photo_unique_${messageId}`, width: 512, height: 512 }];
  if (method === 'sendDocument') result.document = { file_id: typeof payload.document === 'string' ? payload.document : `document_${messageId}`, file_unique_id: `document_unique_${messageId}`, file_name: payload.document?.filename };
  return result;
}

async function callApi(method, payload = {}) {
  apiCalls.push({ method, payload });
  const failure = failureQueues.get(method)?.shift();
  if (failure !== undefined) throw apiError(failure);
  if (method === 'getMe') return { ...currentBot };
  if (method === 'getChat') return chat(payload.chat_id);
  if (method === 'getChatMember') {
    const found = members.get(memberKey(payload.chat_id, payload.user_id));
    if (found) return structuredClone(found);
    if (Number(payload.user_id) === currentBot.id) return { status: 'administrator', user: { ...currentBot }, can_manage_chat: true, is_anonymous: false };
    return { status: 'left', user: { id: Number(payload.user_id), is_bot: false, first_name: `User ${payload.user_id}` } };
  }
  if (method === 'getChatAdministrators') {
    return [...members.entries()]
      .filter(([key, value]) => key.startsWith(`${payload.chat_id}:`) && ['creator', 'administrator'].includes(value.status) && (payload.return_bots || !value.user.is_bot))
      .map(([, value]) => structuredClone(value));
  }
  if (method === 'copyMessage') return { message_id: sentMessage(payload, method).message_id };
  if (method === 'sendMediaGroup') return payload.media.map((media) => sentMessage({ ...payload, ...media }, 'sendMedia'));
  if (method.startsWith('send') || method.startsWith('editMessage') || method === 'forwardMessage') return sentMessage(payload, method);
  return true;
}

export const api = new Proxy({}, {
  get(_target, method) {
    if (typeof method !== 'string' || method === 'then') return undefined;
    return (payload) => callApi(method, payload);
  },
});

// reset() imports the actual application schema. schema is only an optional
// descriptor override for testing this harness itself without another file.
export async function reset({ members: initialMembers = {}, bot = {}, schema } = {}) {
  const definitions = schema ?? await import(new URL('../tgcloud/schema.js', import.meta.url).href);
  const tables = collect(definitions, TABLE);
  if (tables.length === 0) throw new Error('No table() descriptors exported from tgcloud/schema.js.');
  connection?.close();
  connection = new DatabaseSync(':memory:');
  connection.exec('PRAGMA foreign_keys = ON');
  for (const definition of tables) {
    const columns = Object.values(definition.columns).map((value) => {
      const item = value[COLUMN];
      const parts = [quoteIdentifier(item.name), item.type];
      if (item.primaryKey) parts.push('PRIMARY KEY');
      if (item.autoIncrement) parts.push('AUTOINCREMENT');
      if (item.notNull) parts.push('NOT NULL');
      if (item.unique) parts.push('UNIQUE');
      if (item.hasDefault) parts.push('DEFAULT', sqlLiteral(item.defaultValue));
      return parts.join(' ');
    });
    connection.exec(`CREATE TABLE ${quoteIdentifier(definition.name)} (${columns.join(', ')})`);
    for (const item of definition.indexes) {
      const names = item.columns.map((value) => typeof value === 'string' ? value : value[COLUMN]?.name);
      if (!names.length || names.some((name) => !name)) throw new Error(`Invalid index on ${definition.name}`);
      const name = item.name ?? `${definition.name}_${names.join('_')}_${item.unique ? 'unique' : 'index'}`;
      connection.exec(`CREATE ${item.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdentifier(name)} ON ${quoteIdentifier(definition.name)} (${names.map(quoteIdentifier).join(', ')})`);
    }
  }
  currentBot = { ...defaultBot, ...bot };
  members.clear();
  failureQueues.clear();
  nextMessageIds.clear();
  apiCalls.length = 0;
  if (Array.isArray(initialMembers)) {
    for (const entry of initialMembers) {
      const { chat_id, user_id, ...member } = entry;
      setMember(chat_id, user_id ?? member.user?.id, member);
    }
  } else {
    for (const [key, member] of initialMembers instanceof Map ? initialMembers : Object.entries(initialMembers)) {
      const separator = String(key).lastIndexOf(':');
      if (separator < 0) throw new TypeError('reset members keys must use chatId:userId.');
      setMember(String(key).slice(0, separator), String(key).slice(separator + 1), member);
    }
  }
  return { db, api, apiCalls };
}
