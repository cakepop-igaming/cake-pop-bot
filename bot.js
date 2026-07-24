const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

// ==========================================
// 1. ИНИЦИАЛИЗАЦИЯ SUPABASE
// ==========================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Хранилище активных сессий игр на сервере: telegram_id => { mines, bet, revealedCount, minesCount, isGameOver }
const activeGames = new Map();

// ==========================================
// 2. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ БЕЗОПАСНОСТИ
// ==========================================

// Валидация подписи Telegram initData
function verifyTelegramWebAppData(telegramInitData) {
  if (!telegramInitData) return null;

  try {
    const urlParams = new URLSearchParams(telegramInitData);
    const hash = urlParams.get('hash');
    if (!hash) return null;

    urlParams.delete('hash');

    const paramsData = Array.from(urlParams.entries())
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(process.env.8913651056:AAHf0TiSLkvr48Z3ZbOx49B97jEpFyDa0oI)
      .digest();

    const calculatedHash = crypto
      .createHmac('sha256', secretKey)
      .update(paramsData)
      .digest('hex');

    if (calculatedHash === hash) {
      const userStr = urlParams.get('user');
      return userStr ? JSON.parse(userStr) : null;
    }
    return null;
  } catch (e) {
    console.error('Ошибка валидации initData:', e);
    return null;
  }
}

// Расчет множителя
function calculateServerMultiplier(mines, gems) {
  if (gems === 0) return 1.00;
  let prob = 1.0;
  for (let i = 0; i < gems; i++) {
    prob *= (25 - mines - i) / (25 - i);
  }
  let mult = (0.98 / prob) * 0.95;
  return Number(Math.min(mult, 100).toFixed(2));
}

// Получить или создать юзера в БД
async function getOrCreateUser(telegramId, username = 'Gamer') {
  let { data: existingUser } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramId)
    .single();

  if (!existingUser) {
    const { data: newUser, error: insertError } = await supabase
      .from('users')
      .insert([{ telegram_id: telegramId, username: username, balance: 1000.00 }])
      .select()
      .single();

    if (insertError) {
      console.error('Ошибка создания юзера в Supabase:', insertError);
      return null;
    }
    return newUser;
  }

  return existingUser;
}

// ==========================================
// 3. ИНИЦИАЛИЗАЦИЯ TELEGRAM БОТА
// ==========================================
const bot = new Telegraf(process.env.BOT_TOKEN);
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://cake-pop-nine.vercel.app';

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

bot.launch().then(() => {
  console.log('🚀 Бот Cake Pop успешно запущен!');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// ==========================================
// 4. EXPRESS API СЕРВЕР
// ==========================================
const app = express();
app.use(cors());
app.use(express.json());

// 1. Получение баланса
app.get('/api/user', async (req, res) => {
  const telegramId = req.query.telegram_id;
  if (!telegramId) return res.status(400).json({ error: 'telegram_id обязателен' });

  try {
    const user = await getOrCreateUser(telegramId);
    if (!user) return res.status(500).json({ error: 'Ошибка БД' });

    return res.json({ telegram_id: user.telegram_id, username: user.username, balance: user.balance });
  } catch (err) {
    return res.status(500).json({ error: 'Серверная ошибка' });
  }
});

// 2. СТАРТ ИГРЫ (Атомарное списание + Генерация мин на бэкенде)
app.post('/api/game/start', async (req, res) => {
  const { initData, betAmount, minesCount } = req.body;
  const tgUser = verifyTelegramWebAppData(initData);

  // Резервный вариант для локальных тестов в обычном браузере
  const telegramId = tgUser ? tgUser.id : req.body.fallback_telegram_id || 123456789;

  try {
    const user = await getOrCreateUser(telegramId);
    if (!user || user.balance < betAmount) {
      return res.status(400).json({ error: 'Недостаточно средств!' });
    }

    const newBalance = user.balance - betAmount;

    // Списываем ставку
    const { error: updateError } = await supabase
      .from('users')
      .update({ balance: newBalance })
      .eq('telegram_id', telegramId);

    if (updateError) return res.status(500).json({ error: 'Ошибка списания баланса' });

    // Генерация мин СТРОГО НА СЕРВЕРЕ
    const mineIndices = new Set();
    while (mineIndices.size < Number(minesCount)) {
      mineIndices.add(Math.floor(Math.random() * 25));
    }

    // Сохраняем активную сессию
    activeGames.set(String(telegramId), {
      mines: mineIndices,
      bet: Number(betAmount),
      revealedCount: 0,
      minesCount: Number(minesCount),
      isGameOver: false
    });

    console.log(`🎮 Игра начата [ID: ${telegramId}]. Списано: ${betAmount}. Мины сгенерированы.`);
    return res.json({ success: true, balance: newBalance });

  } catch (err) {
    console.error('Ошибка в /api/game/start:', err);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 3. ОТКРЫТИЕ ЯЧЕЙКИ (Проверка попадания)
app.post('/api/game/open-cell', async (req, res) => {
  const { initData, cellIndex } = req.body;
  const tgUser = verifyTelegramWebAppData(initData);
  const telegramId = tgUser ? tgUser.id : req.body.fallback_telegram_id || 123456789;

  const game = activeGames.get(String(telegramId));
  if (!game || game.isGameOver) {
    return res.status(400).json({ error: 'Нет активной игры' });
  }

  // Если попал на мину
  if (game.mines.has(Number(cellIndex))) {
    game.isGameOver = true;
    const allMines = Array.from(game.mines);
    activeGames.delete(String(telegramId));

    return res.json({ hitMine: true, mines: allMines });
  }

  // Успешный клик
  game.revealedCount++;
  const multiplier = calculateServerMultiplier(game.minesCount, game.revealedCount);
  const currentProfit = Math.floor(game.bet * multiplier);

  return res.json({
    hitMine: false,
    multiplier: multiplier,
    profit: currentProfit
  });
});

// 4. ЗАБРАТЬ ВЫИГРЫШ (Кэшаут)
app.post('/api/game/cashout', async (req, res) => {
  const { initData } = req.body;
  const tgUser = verifyTelegramWebAppData(initData);
  const telegramId = tgUser ? tgUser.id : req.body.fallback_telegram_id || 123456789;

  const game = activeGames.get(String(telegramId));
  if (!game || game.isGameOver) {
    return res.status(400).json({ error: 'Активная игра не найдена' });
  }

  const multiplier = calculateServerMultiplier(game.minesCount, game.revealedCount);
  const winTotal = Math.floor(game.bet * multiplier);

  try {
    const user = await getOrCreateUser(telegramId);
    const updatedBalance = Number(user.balance) + winTotal;

    await supabase
      .from('users')
      .update({ balance: updatedBalance })
      .eq('telegram_id', telegramId);

    const allMines = Array.from(game.mines);
    activeGames.delete(String(telegramId));

    console.log(`🏆 Выигрыш забрали [ID: ${telegramId}]: +${winTotal}. Баланс: ${updatedBalance}`);

    return res.json({
      success: true,
      balance: updatedBalance,
      winAmount: winTotal,
      mines: allMines
    });
  } catch (err) {
    console.error('Ошибка в /api/game/cashout:', err);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Начисление бесплатного бонуса
app.post('/api/bonus', async (req, res) => {
  const { telegram_id } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'Без ID нельзя' });

  try {
    const user = await getOrCreateUser(telegram_id);
    const newBalance = Number(user.balance) + 500;

    const { data: updated } = await supabase
      .from('users')
      .update({ balance: newBalance })
      .eq('telegram_id', telegram_id)
      .select()
      .single();

    return res.json({ success: true, balance: updated.balance });
  } catch (err) {
    return res.status(500).json({ error: 'Ошибка бонуса' });
  }
});

app.get('/', (req, res) => res.send('Cake Pop Secure Backend Active!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 API сервер запущен на порту ${PORT}`);
});