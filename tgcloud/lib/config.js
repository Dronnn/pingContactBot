// Меняются до tgcloud push. Секретов и токена бота в этом проекте нет.
export const LIMITS = Object.freeze({
  contactsPerChat: 20,
  contactsPerHour: 5,
  textLength: 3000,
  titleLength: 64,
  descriptionLength: 240,
  visitorMessagesPerMinute: 5,
  visitorMessagesPerHour: 30,
  incomingPerChatMinute: 12,
  actionsPerMinute: 40,
  newConversationsPerDay: 40,
  pageSize: 6,
  sessionMs: 30 * 60 * 1000,
  routeMs: 30 * 24 * 60 * 60 * 1000,
  eventMs: 7 * 24 * 60 * 60 * 1000,
});

export const COMMAND_VERSION = 'contact-for-thing-v1';
export const PRIVATE_COMMANDS = [
  ['start', 'Открыть меню'], ['new', 'Создать контакт'],
  ['contacts', 'Мои контакты'], ['inbox', 'Мои диалоги'],
  ['reply', 'Ответить: /reply номер текст'], ['blocked', 'Заблокированные собеседники'],
  ['cancel', 'Отменить ввод'], ['help', 'Инструкция и команды'],
  ['privacy', 'Что видят собеседники'], ['setup', 'Проверить бота и обновить меню'],
].map(([command, description]) => ({ command, description }));
export const GROUP_COMMANDS = [
  ['contacts', 'Контакты этого чата'], ['inbox', 'Диалоги этого чата'],
  ['new', 'Создать контакт чата — администраторы'],
  ['reply', 'Ответить: /reply номер текст'],
  ['blocked', 'Блокировки чата — администраторы'],
  ['move', 'Перенести контакт в эту тему: /move номер'],
  ['cancel', 'Отменить мой ввод'], ['help', 'Как отвечать от имени чата'],
  ['privacy', 'Что видят собеседники'], ['setup', 'Проверить подключение чата'],
].map(([command, description]) => ({ command, description }));
