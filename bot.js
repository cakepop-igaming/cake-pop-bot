const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Инициализация Supabase клиентом с Service Role
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

const bot = new Telegraf(process.env.BOT_TOKEN);
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://cake-pop-nine.vercel.app';

// Ответ на команду /start
bot.start(async (ctx) => {
  const user = ctx.from;
  const telegramId = user.id;
  const userName = user.first_name || 'Друг';
  const usernameHandle = user.username || userName;

  try {
    // 1. Проверяем, есть ли пользователь в базе Supabase
    let { data: existingUser, error: selectError } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', telegramId)
      .single();

    if (selectError && selectError.code !== 'PGRST116') { // PGRST116 = строка не найдена
      console.error('Ошибка при поиске юзера в Supabase:', selectError);
    }

    // 2. Если пользователя нет — создаем новую запись со стартовым балансом
    if (!existingUser) {
      const { data: newUser, error: insertError } = await supabase
        .from('users')
        .insert([
          { 
            telegram_id: telegramId, 
            username: usernameHandle, 
            balance: 1000.00 // Стартовый баланс
          }
        ])
        .select()
        .single();

      if (insertError) {
        console.error('Ошибка создания юзера в Supabase:', insertError);
      } else {
        existingUser = newUser;
        console.log(`✨ Новый игрок зарегистрирован в БД: ${usernameHandle} (${telegramId})`);
      }
    }

    // Получаем текущий баланс пользователя из БД
    const currentBalance = existingUser ? existingUser.balance : 1000.00;

    const text = `Привет, ${userName}! 🧁\n\n` +
                 `Добро пожаловать в Cake Pop!\n` +
                 `Твой текущий баланс: **${currentBalance} $CAKE** 🚀`;

    await ctx.reply(
      text,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.webApp('🧁 Запустить Cake Pop', WEBAPP_URL)]
        ])
      }
    );
  } catch (err) {
    console.error('Общая ошибка в /start:', err);
    ctx.reply('Произошла ошибка при загрузке профиля. Попробуй позже!');
  }
});

// Сообщение в консоль при запуске
bot.launch().then(() => {
  console.log('🚀 Бот Cake Pop успешно запущен и работает!');
});

// Плавная остановка
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

const http = require('http');

// Создаем минимальный HTTP-сервер для Render Free Tier
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Cake Pop Bot is alive!');
}).listen(PORT, () => {
  console.log(`🌐 HTTP-сервер слушает порт ${PORT}`);
});