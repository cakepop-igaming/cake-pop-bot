const { Telegraf, Markup } = require('telegraf');
require('dotenv').config();

const bot = new Telegraf(process.env.BOT_TOKEN);
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://cake-pop-nine.vercel.app';

// Ответ на команду /start
bot.start(async (ctx) => {
  const userName = ctx.from.first_name || 'Друг';
  
  const text = `Привет, ${userName}! 🧁\n` +
               `Добро пожаловать в Cake Pop! Твой стартовый эирдроп в 1,000 $CAKE уже на балансе. Погнали? 🚀`;

  await ctx.reply(
    text,
    Markup.inlineKeyboard([
      [Markup.button.webApp('🧁 Запустить Cake Pop', WEBAPP_URL)]
    ])
  );
});

// Сообщение в консоль при запуске
bot.launch().then(() => {
  console.log('🚀 Бот Cake Pop успешно запущен и работает!');
});

// Плавная остановка
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));