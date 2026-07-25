const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { Telegraf } = require('telegraf');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// Инициализация Supabase & Telegraf
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const botToken = process.env.BOT_TOKEN;

const supabase = createClient(supabaseUrl, supabaseKey);
const bot = new Telegraf(botToken);

// Хранилище активных сессий игр в памяти
const activeGames = new Map();

// Проверка валидности Telegram initData (HMAC-SHA256)
function verifyTelegramWebAppData(initData) {
  if (!initData) return null;
  const urlParams = new URLSearchParams(initData);
  const hash = urlParams.get('hash');
  urlParams.delete('hash');

  const params = [];
  for (const [key, value] of urlParams.entries()) {
    params.push(`${key}=${value}`);
  }
  params.sort();
  const dataCheckString = params.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (calculatedHash === hash) {
    const userJson = urlParams.get('user');
    return userJson ? JSON.parse(userJson) : null;
  }
  return null;
}

// Вспомогательная функция для безопасного получения telegram_id
function getAuthenticatedUserId(req) {
  const { initData, fallback_telegram_id } = req.body;
  const verifiedUser = verifyTelegramWebAppData(initData);
  if (verifiedUser) return verifiedUser.id;
  return fallback_telegram_id;
}

// Функция для обновления сообщения с балансом в чате Telegram
async function updateTelegramChatMessage(telegramId, newBalance) {
  try {
    const text = `🍰 **Добро пожаловать в Cake Pop!**\n\nТвой текущий баланс: **${Math.floor(newBalance)} $CAKE**\n\nНажми кнопку ниже, чтобы запустить Mini App и сыграть!`;
    // Отправляем или обновляем сообщение (Telegram API позволяет отправить новое или изменить текущее)
    await bot.telegram.sendMessage(telegramId, text, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: "🧁 Играть в Cake Pop", web_app: { url: process.env.WEBAPP_URL || "https://cake-pop-nine.vercel.app" } }]
        ]
      }
    });
  } catch (err) {
    console.error("Ошибка обновления сообщения в TG:", err.message);
  }
}

// Команда /start в Telegram
bot.start(async (ctx) => {
  const telegramId = ctx.from.id;
  const username = ctx.from.username || ctx.from.first_name || 'Player';

  let { data: user } = await supabase.from('users').select('*').eq('telegram_id', telegramId).single();

  if (!user) {
    const { data: newUser } = await supabase.from('users').insert([{
      telegram_id: telegramId,
      username: username,
      balance: 1000
    }]).select().single();
    user = newUser;
  }

  const balance = user ? user.balance : 1000;

  ctx.replyWithMarkdown(
    `🍰 **Добро пожаловать в Cake Pop!**\n\nТвой текущий баланс: **${Math.floor(balance)} $CAKE**\n\nНажми кнопку ниже, чтобы запустить Mini App и сыграть!`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🧁 Играть в Cake Pop", web_app: { url: process.env.WEBAPP_URL || "https://cake-pop-nine.vercel.app" } }]
        ]
      }
    }
  );
});

// GET /api/user — получение баланса
app.get('/api/user', async (req, res) => {
  const telegramId = req.query.telegram_id;
  if (!telegramId) return res.status(400).json({ error: 'Missing telegram_id' });

  const { data: user } = await supabase.from('users').select('balance').eq('telegram_id', telegramId).single();

  if (user) {
    res.json({ balance: user.balance });
  } else {
    res.status(404).json({ error: 'User not found' });
  }
});

// POST /api/game/start — Старт игры
app.post('/api/game/start', async (req, res) => {
  const telegramId = getAuthenticatedUserId(req);
  const { betAmount, minesCount } = req.body;

  if (!telegramId) return res.status(401).json({ error: 'Unauthorized' });

  const { data: user } = await supabase.from('users').select('balance').eq('telegram_id', telegramId).single();
  if (!user || user.balance < betAmount) {
    return res.status(400).json({ error: 'Недостаточно $CAKE на балансе' });
  }

  // Генерируем мины
  const mines = [];
  while (mines.length < minesCount) {
    const rand = Math.floor(Math.random() * 25);
    if (!mines.includes(rand)) mines.push(rand);
  }

  const newBalance = Number(user.balance) - Number(betAmount);
  await supabase.from('users').update({ balance: newBalance }).eq('telegram_id', telegramId);

  activeGames.set(telegramId, {
    betAmount: Number(betAmount),
    minesCount: Number(minesCount),
    mines: mines,
    revealedCells: [],
    currentMultiplier: 1.00
  });

  res.json({ success: true, balance: newBalance });
});

// POST /api/game/open-cell — Открытие ячейки
app.post('/api/game/open-cell', async (req, res) => {
  const telegramId = getAuthenticatedUserId(req);
  const { cellIndex } = req.body;

  const game = activeGames.get(telegramId);
  if (!game) return res.status(400).json({ error: 'Игра не найдена' });

  if (game.mines.includes(cellIndex)) {
    const allMines = game.mines;
    activeGames.delete(telegramId);

    // Получаем текущий баланс для уведомления
    const { data: user } = await supabase.from('users').select('balance').eq('telegram_id', telegramId).single();
    if (user) updateTelegramChatMessage(telegramId, user.balance);

    return res.json({ hitMine: true, mines: allMines });
  }

  if (!game.revealedCells.includes(cellIndex)) {
    game.revealedCells.push(cellIndex);
  }

  // Расчет множителя
  const safeCellsCount = 25 - game.minesCount;
  const openedCount = game.revealedCells.length;
  let mult = 1.00;
  for (let i = 0; i < openedCount; i++) {
    mult *= (25 - i) / (safeCellsCount - i);
  }
  mult = parseFloat(mult.toFixed(2));
  game.currentMultiplier = mult;

  const profit = Math.floor(game.betAmount * mult);

  res.json({
    hitMine: false,
    multiplier: mult,
    profit: profit
  });
});

// POST /api/game/cashout — Забрать выигрыш
app.post('/api/game/cashout', async (req, res) => {
  const telegramId = getAuthenticatedUserId(req);
  const game = activeGames.get(telegramId);

  if (!game) return res.status(400).json({ error: 'Активная игра не найдена' });

  const winAmount = Math.floor(game.betAmount * game.currentMultiplier);

  const { data: user } = await supabase.from('users').select('balance').eq('telegram_id', telegramId).single();
  const newBalance = Number(user.balance) + winAmount;

  await supabase.from('users').update({ balance: newBalance }).eq('telegram_id', telegramId);

  const allMines = game.mines;
  activeGames.delete(telegramId);

  // Обновляем сообщение в чате Telegram
  updateTelegramChatMessage(telegramId, newBalance);

  res.json({
    success: true,
    balance: newBalance,
    winAmount: winAmount,
    mines: allMines
  });
});

// POST /api/bonus — Бонус +500
app.post('/api/bonus', async (req, res) => {
  const { telegram_id } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'Missing telegram_id' });

  const { data: user } = await supabase.from('users').select('balance').eq('telegram_id', telegram_id).single();
  if (!user) return res.status(404).json({ error: 'User not found' });

  const newBalance = Number(user.balance) + 500;
  await supabase.from('users').update({ balance: newBalance }).eq('telegram_id', telegram_id);

  updateTelegramChatMessage(telegram_id, newBalance);

  res.json({ success: true, balance: newBalance });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

bot.launch();