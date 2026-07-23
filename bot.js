const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

// ==========================================
// 1. ИНИЦИАЛИЗАЦИЯ SUPABASE
// ==========================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// ==========================================
// 2. ИНИЦИАЛИЗАЦИЯ TELEGRAM БОТА
// ==========================================
const bot = new Telegraf(process.env.BOT_TOKEN);
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://cake-pop-nine.vercel.app';

// Вспомогательная функция: Получить или создать юзера в БД
async function getOrCreateUser(telegramId, username = 'Gamer') {
  let { data: existingUser, error: selectError } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramId)
    .single();

  if (!existingUser) {
    const { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert([
        { 
          telegram_id: telegramId, 
          username: username, 
          balance: 1000.00 
        }
      ])
      .select()
      .single();

    if (insertError) {
      console.error('Ошибка создания юзера в Supabase:', insertError);
      return null;
    }
    console.log(`✨ Новый игрок зарегистрирован в БД: ${username} (${telegramId})`);
    return newUser;
  }

  return existingUser;
}

bot.start(async (ctx) => {
  const user = ctx.from;
  const telegramId = user.id;
  const userName = user.first_name || 'Друг';
  const usernameHandle = user.username || userName;

  try {
    const dbUser = await getOrCreateUser(telegramId, usernameHandle);
    const currentBalance = dbUser ? dbUser.balance : 1000.00;

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

// Запуск бота
bot.launch().then(() => {
  console.log('🚀 Бот Cake Pop успешно запущен и работает!');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// ==========================================
// 3. ИНИЦИАЛИЗАЦИЯ EXPRESS СЕРВЕРА С ЭНДПОИНТАМИ
// ==========================================
const app = express();

// Настройка CORS (разрешаем WebApp с Vercel общаться с Render)
app.use(cors());
app.use(express.json());

// ЭНДПОИНТ #1: Получение пользователя и его баланса
app.get('/api/user', async (req, res) => {
  const telegramId = req.query.telegram_id;

  if (!telegramId) {
    return res.status(400).json({ error: 'telegram_id обязателен' });
  }

  try {
    // Получаем юзера или создаем его (если зашли впервые или тестируем)
    const user = await getOrCreateUser(telegramId);

    if (!user) {
      return res.status(500).json({ error: 'Не удалось получить данные пользователя' });
    }

    return res.json({
      telegram_id: user.telegram_id,
      username: user.username,
      balance: user.balance
    });
  } catch (err) {
    console.error('Ошибка в GET /api/user:', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// ЭНДПОИНТ #2: Изменение баланса по результату игры
app.post('/api/game-result', async (req, res) => {
  const { telegram_id, change_amount } = req.body;

  if (!telegram_id || change_amount === undefined || isNaN(change_amount)) {
    return res.status(400).json({ error: 'Неверные параметры запроса' });
  }

  try {
    // 1. Получаем юзера (или создаём, если не существует)
    const user = await getOrCreateUser(telegram_id);

    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    // 2. Рассчитываем новый баланс
    const currentBalance = Number(user.balance);
    const amount = Number(change_amount);
    const newBalance = currentBalance + amount;

    // Защита от ухода баланса в минус
    if (newBalance < 0) {
      return res.status(400).json({ error: 'Недостаточно средств на балансе' });
    }

    // 3. Сохраняем новый баланс в Supabase
    const { data: updatedUser, error: updateError } = await supabase
      .from('users')
      .update({ balance: newBalance })
      .eq('telegram_id', telegram_id)
      .select()
      .single();

    if (updateError) {
      console.error('Ошибка обновления баланса в Supabase:', updateError);
      return res.status(500).json({ error: 'Не удалось обновить баланс' });
    }

    console.log(`💰 Баланс ${telegram_id} изменен на ${amount}. Новый баланс: ${updatedUser.balance}`);

    return res.json({
      success: true,
      balance: updatedUser.balance
    });

  } catch (err) {
    console.error('Ошибка в POST /api/game-result:', err);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// Пинг для UptimeRobot
app.get('/', (req, res) => {
  res.send('Cake Pop Bot & API are alive!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Express API сервер слушает порт ${PORT}`);
});