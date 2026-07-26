require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { Telegraf } = require('telegraf');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
});

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const botToken = process.env.BOT_TOKEN;
const webAppUrl = process.env.WEBAPP_URL || 'https://cake-pop-nine.vercel.app';

const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseKey || 'placeholder-key');
const bot = new Telegraf(botToken || '123456:placeholder');

// Хранилище активных игр
const activeGames = new Map();

function verifyTelegramWebAppData(initData) {
  if (!initData) return null;
  try {
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
  } catch (err) {
    console.error('Verification error:', err.message);
  }
  return null;
}

function getAuthenticatedUserId(req) {
  const { initData, fallback_telegram_id } = req.body;
  const verifiedUser = verifyTelegramWebAppData(initData);
  if (verifiedUser) return verifiedUser.id;
  return fallback_telegram_id;
}

// 🔄 Обновление ОДНОГО существующего сообщения с балансом
async function updateTelegramChatMessage(telegramId, newBalance) {
  try {
    const { data: user } = await supabase.from('users').select('last_msg_id').eq('telegram_id', telegramId).single();
    const text = `🍰 **Добро пожаловать в Cake Pop!**\n\nТвой текущий баланс: **${Math.floor(newBalance)} $CAKE**\n\nНажми кнопку ниже, чтобы запустить Mini App и сыграть!`;
    const keyboard = {
      inline_keyboard: [
        [{ text: "🧁 Играть в Cake Pop", web_app: { url: webAppUrl } }]
      ]
    };

    if (user && user.last_msg_id) {
      // Редактируем старое сообщение
      await bot.telegram.editMessageText(telegramId, user.last_msg_id, null, text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
    } else {
      // Если ID нет, отправляем новое и сохраняем ID
      const sentMsg = await bot.telegram.sendMessage(telegramId, text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard
      });
      await supabase.from('users').update({ last_msg_id: sentMsg.message_id }).eq('telegram_id', telegramId);
    }
  } catch (err) {
    console.error("Не удалось обновить сообщение в TG (возможно, оно не изменилось или удалено):", err.message);
  }
}

// Команда /start
bot.start(async (ctx) => {
  try {
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
    const text = `🍰 **Добро пожаловать в Cake Pop!**\n\nТвой текущий баланс: **${Math.floor(balance)} $CAKE**\n\nНажми кнопку ниже, чтобы запустить Mini App и сыграть!`;

    const sentMsg = await ctx.replyWithMarkdown(text, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🧁 Играть в Cake Pop", web_app: { url: webAppUrl } }]
        ]
      }
    });

    // Сохраняем ID отправленного сообщения
    await supabase.from('users').update({ last_msg_id: sentMsg.message_id }).eq('telegram_id', telegramId);

  } catch (err) {
    console.error('Error in /start:', err.message);
  }
});

// GET /api/user — Баланс
app.get('/api/user', async (req, res) => {
  const telegramId = req.query.telegram_id;
  if (!telegramId) return res.status(400).json({ error: 'Missing telegram_id' });

  try {
    const { data: user } = await supabase.from('users').select('balance').eq('telegram_id', telegramId).single();
    if (user) {
      res.json({ balance: user.balance });
    } else {
      res.status(404).json({ error: 'User not found' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST /api/game/start — Старт раунда (с защитой от 2 устройств)
app.post('/api/game/start', async (req, res) => {
  const telegramId = getAuthenticatedUserId(req);
  const { betAmount, minesCount } = req.body;

  if (!telegramId) return res.status(401).json({ error: 'Unauthorized' });

  // 🚫 ЗАЩИТА: Если у пользователя УЖЕ есть активная игра на другом устройстве
  if (activeGames.has(telegramId)) {
    return res.status(400).json({ error: 'Игра уже запущена на другом устройстве!' });
  }

  try {
    const { data: user } = await supabase.from('users').select('balance').eq('telegram_id', telegramId).single();
    if (!user || user.balance < betAmount) {
      return res.status(400).json({ error: 'Недостаточно $CAKE на балансе' });
    }

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
      currentMultiplier: 1.00,
      isProcessing: false
    });

    res.json({ success: true, balance: newBalance });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start game' });
  }
});

// POST /api/game/open-cell — Открытие клетки
app.post('/api/game/open-cell', async (req, res) => {
  const telegramId = getAuthenticatedUserId(req);
  const { cellIndex } = req.body;

  const game = activeGames.get(telegramId);
  if (!game) return res.status(400).json({ error: 'Игра не найдена' });

  if (game.mines.includes(cellIndex)) {
    const allMines = game.mines;
    activeGames.delete(telegramId);

    const { data: user } = await supabase.from('users').select('balance').eq('telegram_id', telegramId).single();
    if (user) updateTelegramChatMessage(telegramId, user.balance);

    return res.json({ hitMine: true, mines: allMines });
  }

  if (!game.revealedCells.includes(cellIndex)) {
    game.revealedCells.push(cellIndex);
  }

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

  if (game.isProcessing) {
    return res.status(429).json({ error: 'Запрос уже обрабатывается' });
  }
  game.isProcessing = true;

  try {
    const winAmount = Math.floor(game.betAmount * game.currentMultiplier);

    const { data: user } = await supabase.from('users').select('balance').eq('telegram_id', telegramId).single();
    const newBalance = Number(user.balance) + winAmount;

    await supabase.from('users').update({ balance: newBalance }).eq('telegram_id', telegramId);

    const allMines = game.mines;
    activeGames.delete(telegramId);

    updateTelegramChatMessage(telegramId, newBalance);

    res.json({
      success: true,
      balance: newBalance,
      winAmount: winAmount,
      mines: allMines
    });
  } catch (err) {
    game.isProcessing = false;
    res.status(500).json({ error: 'Cashout failed' });
  }
});

// POST /api/bonus — Кликер / Бонус +500
app.post('/api/bonus', async (req, res) => {
  const { telegram_id } = req.body;
  if (!telegram_id) return res.status(400).json({ error: 'Missing telegram_id' });

  try {
    const { data: user } = await supabase.from('users').select('balance').eq('telegram_id', telegram_id).single();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const newBalance = Number(user.balance) + 500;
    await supabase.from('users').update({ balance: newBalance }).eq('telegram_id', telegram_id);

    updateTelegramChatMessage(telegram_id, newBalance);

    res.json({ success: true, balance: newBalance });
  } catch (err) {
    res.status(500).json({ error: 'Bonus update failed' });
  }
});

// Запуск HTTP-сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

if (botToken) {
  bot.launch()
    .then(() => console.log('Telegram Bot successfully started!'))
    .catch((err) => console.error('Error starting bot:', err.message));
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));