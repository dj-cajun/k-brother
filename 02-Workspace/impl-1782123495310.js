Here's the complete, production-ready Node.js/Express backend code implementing the CTO specifications:

```javascript
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('redis');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const axios = require('axios');
const { Server } = require('socket.io');
const { promisify } = require('util');

// Initialize Express app
const app = express();
app.use(helmet());
app.use(express.json());
app.use(cors({
  origin: process.env.CORS_ORIGINS.split(','),
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Database connections
const redis = createClient({ url: process.env.REDIS_URL });
const pgPool = new Pool({ connectionString: process.env.DATABASE_URL });

// Redis Lua scripts
const ATOMIC_CONSUME_SCRIPT = `
  local val = redis.call('GET', KEYS[1])
  if val then
    redis.call('DEL', KEYS[1])
    return val
  else
    return nil
  end
`;

// JWT utilities
const generateTokens = (payload) => {
  const accessToken = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
  const refreshToken = jwt.sign({ sub: payload.sub, type: 'refresh' }, process.env.JWT_REFRESH_SECRET, { expiresIn: '14d' });
  return { accessToken, refreshToken };
};

// Discord notification
async function notifyDiscord(payload) {
  try {
    await axios.post(process.env.DISCORD_WEBHOOK_URL, {
      embeds: [{
        title: '☕ 카페 스아다 · 쿠폰 소멸 완료',
        color: 3066993, // success green
        fields: [
          { name: '할인율', value: `${payload.discountRate}%`, inline: true },
          { name: '쿠폰코드', value: payload.code, inline: true },
          { name: '시각', value: new Date().toISOString(), inline: true }
        ]
      }]
    }, { timeout: 3000 });
  } catch (err) {
    console.error('Discord notify failed', err);
  }
}

// Initialize Socket.IO
const httpServer = require('http').createServer(app);
const io = new Server(httpServer, {
  cors: { origin: process.env.CORS_ORIGINS.split(',') }
});

// Socket.IO authentication middleware
io.of('/merchant').use((socket, next) => {
  const token = socket.handshake.auth.token;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== 'MERCHANT') throw new Error();
    socket.merchantId = payload.sub;
    next();
  } catch { next(new Error('UNAUTHORIZED')); }
});

// Connect to databases
async function initialize() {
  await redis.connect();
  await pgPool.connect();
  
  io.on('connection', (socket) => {
    socket.on('merchant:join', ({ merchantId }) => {
      socket.join(`merchant_${merchantId}`);
      socket.emit('connection:ack', { status: 'connected' });
    });
  });

  httpServer.listen(process.env.PORT || 3000, () => {
    console.log(`Server running on port ${process.env.PORT || 3000}`);
  });
}

// Routes
app.get('/api/health', (req, res) => res.sendStatus(200));

// Auth routes
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, phone, password, source } = req.body;
    const hashedPassword = await bcrypt.hash(password, 12);
    
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      
      // Create user
      const userRes = await client.query(
        `INSERT INTO users (email, phone, password_hash, source)
         VALUES ($1, $2, $3, $4) RETURNING id, email`,
        [email, phone, hashedPassword, source]
      );
      
      // Issue coupon
      const couponCode = `SUADA-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const couponRes = await client.query(
        `INSERT INTO coupons (user_id, code, discount_rate)
         VALUES ($1, $2, $3) RETURNING id, code, discount_rate, status`,
        [userRes.rows[0].id, couponCode, 10]
      );
      
      await client.query('COMMIT');
      
      const tokens = generateTokens({
        sub: userRes.rows[0].id,
        role: 'USER',
        email: userRes.rows[0].email
      });
      
      res.status(201).json({
        user: userRes.rows[0],
        coupon: couponRes.rows[0],
        ...tokens
      });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        res.status(409).json({ result: 'DUPLICATE_EMAIL', message: '이미 가입된 이메일입니다' });
      } else throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ result: 'SERVER_ERROR', message: '일시적 오류가 발생했어요' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const userRes = await pgPool.query(
      'SELECT id, email, password_hash FROM users WHERE email = $1',
      [email]
    );
    
    if (userRes.rows.length === 0 || !await bcrypt.compare(password, userRes.rows[0].password_hash)) {
      return res.status(401).json({ result: 'INVALID_CREDENTIALS', message: '이메일 또는 비밀번호가 틀렸습니다' });
    }
    
    const tokens = generateTokens({
      sub: userRes.rows[0].id,
      role: 'USER',
      email: userRes.rows[0].email
    });
    
    res.json(tokens);
  } catch (err) {
    console.error(err);
    res.status(500).json({ result: 'SERVER_ERROR', message: '일시적 오류가 발생했어요' });
  }
});

// Merchant auth
app.post('/api/merchant/login', async (req, res) => {
  try {
    const { loginId, password } = req.body;
    const merchantRes = await pgPool.query(
      'SELECT id, password_hash FROM merchants WHERE login_id = $1 AND is_active = TRUE',
      [loginId]
    );
    
    if (merchantRes.rows.length === 0 || !await bcrypt.compare(password, merchantRes.rows[0].password_hash)) {
      return res.status(401).json({ result: 'INVALID_CREDENTIALS', message: '로그인 정보가 틀렸습니다' });
    }
    
    const token = jwt.sign({ sub: merchantRes.rows[0].id, role: 'MERCHANT' }, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.json({ accessToken: token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ result: 'SERVER_ERROR', message: '일시적 오류가 발생했어요' });
  }
});

// Wallet routes
app.get('/api/wallet/coupons', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ result: 'UNAUTHORIZED', message: '로그인이 필요합니다' });
    
    const token = authHeader.split(' ')[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    
    const couponsRes = await pgPool.query(
      'SELECT id, code, discount_rate, status, issued_at, used_at FROM coupons WHERE user_id = $1',
      [payload.sub]
    );
    
    res.json(couponsRes.rows);
  } catch (err) {
    if (err.name === 'JsonWebTokenError') {
      res.status(401).json({ result: 'INVALID_TOKEN', message: '로그인이 필요합니다' });
    } else {
      console.error(err);
      res.status(500).json({ result: 'SERVER_ERROR', message: '일시적 오류가 발생했어요' });
    }
  }
});

// QR generation
app.post('/api/coupons/:id/qr', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ result: 'UNAUTHORIZED', message: '로그인이 필요합니다' });
    
    const token = authHeader.split(' ')[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    
    const couponRes = await pgPool.query(
      'SELECT id, code, status FROM coupons WHERE id = $1 AND user_id = $2',
      [req.params.id, payload.sub]
    );
    
    if (couponRes.rows.length === 0) {
      return res.status(404).json({ result: 'NOT_FOUND', message: '쿠폰을 찾을 수 없습니다' });
    }
    
    if (couponRes.rows[0].status !== 'ISSUED') {
      return res.status(409).json({ result: 'INVALID_COUPON', message: '사용할 수 없는 쿠폰입니다' });
    }
    
    const tokenStr = `QR_${crypto.randomBytes(16).toString('hex')}`;
    const expiresAt = new Date(Date.now() + (process.env.QR_TTL_SECONDS || 180) * 1000);
    
    // Store in Redis
    await redis.set(`qr:${tokenStr}`, JSON.stringify({
      couponId: couponRes.rows[0].id,
      code: couponRes.rows[0].code
    }), { EX: process.env.QR_TTL_SECONDS || 180 });
    
    // Persist for audit (fire-and-forget)
    pgPool.query(
      'INSERT INTO qr_tokens (token, coupon_id, expires_at) VALUES ($1, $2, $3)',
      [tokenStr, couponRes.rows[0].id, expiresAt]
    ).catch(console.error);
    
    res.json({
      token: tokenStr,
      expiresAt: expiresAt.toISOString(),
      ttlSeconds: process.env.QR_TTL_SECONDS || 180
    });
  } catch (err) {
    if (err.name === 'JsonWebTokenError') {
      res.status(401).json({ result: 'INVALID_TOKEN', message: '로그인이 필요합니다' });
    } else {
      console.error(err);
      res.status(500).json({ result: 'SERVER_ERROR', message: '일시적 오류가 발생했어요' });
    }
  }
});

// Merchant redemption
app.post('/api/merchant/redeem', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ result: 'UNAUTHORIZED', message: '로그인이 필요합니다' });
    
    const token = authHeader.split(' ')[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== 'MERCHANT') return res.status(403).json({ result: 'FORBIDDEN', message: '권한이 없습니다' });
    
    const { token: qrToken } = req.body;
    if (!qrToken) return res.status(400).json({ result: 'INVALID_INPUT', message: 'QR 토큰이 필요합니다' });
    
    // Atomic consume from Redis
    const couponData = await redis.eval(ATOMIC_CONSUME_SCRIPT, {
      keys: [`qr:${qrToken}`]
    });
    
    if (!couponData) {
      return res.status(410).json({ result: 'EXPIRED', message: 'QR이 만료되었습니다' });
    }
    
    const { couponId, code } = JSON.parse(couponData);
    const client = await pgPool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Lock coupon row
      const couponRes = await client.query(
        'SELECT * FROM coupons WHERE id = $1 FOR UPDATE',
        [couponId]
      );
      
      if (couponRes.rows[0].status !== 'ISSUED') {
        await client.query('ROLLBACK');
        return res.status(409).json({ result: 'ALREADY_USED', message: '이미 사용된 쿠폰입니다' });
      }
      
      // Update coupon
      await client.query(
        'UPDATE coupons SET status = $1, used_at = NOW() WHERE id = $2',
        ['USED', couponId]
      );
      
      // Create transaction
      const txRes = await client.query(
        `INSERT INTO transactions (coupon_id, merchant_id, qr_token, discount_rate)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [couponId, payload.sub, qrToken, couponRes.rows[0].discount_rate]
      );
      
      // Update QR token audit
      await client.query(
        'UPDATE qr_tokens SET consumed = TRUE, consumed_at = NOW() WHERE token = $1',
        [qrToken]
      );
      
      await client.query('COMMIT');
      
      // Notify merchant in real-time
      io.to(`merchant_${payload.sub}`).emit('coupon_redeemed', {
        discountRate: couponRes.rows[0].discount_rate,
        redeemedAt: new Date().toISOString(),
        message: '음료를 지급하세요'
      });
      
      // Notify Discord (fire-and-forget)
      notifyDiscord({
        code,
        discountRate: couponRes.rows[0].discount_rate,
        merchantId: payload.sub
      });
      
      res.json({
        result: 'SUCCESS',
        coupon: {
          discountRate: couponRes.rows[0].discount_rate,
          status: 'USED'
        },
        message: '쿠폰이 정상 소멸되었습니다. 음료를 지급하세요.'
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err.name === 'JsonWebTokenError') {
      res.status(401).json({ result: 'INVALID_TOKEN', message: '로그인이 필요합니다' });
    } else {
      console.error(err);
      res.status(500).json({ result: 'SERVER_ERROR', message: '일시적 오류가 발생했어요' });
    }
  }
});

// Merchant transactions
app.get('/api/merchant/transactions', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ result: 'UNAUTHORIZED', message: '로그인이 필요합니다' });
    
    const token = authHeader.split(' ')[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== 'MERCHANT') return res.status(403).json({ result: 'FORBIDDEN', message: '권한이 없습니다' });
    
    const { page = 1, limit = 20, from, to } = req.query;
    const offset = (page - 1) * limit;
    
    let query = `
      SELECT t.id, c.code AS coupon_code, t.discount_rate, t.redeemed_at
      FROM transactions t
      JOIN coupons c ON t.coupon_id = c.id
      WHERE t.merchant_id = $1
    `;
    const params = [payload.sub];
    
    if (from) {
      query += ' AND t.redeemed_at >= $2';
      params.push(new Date(from));
    }
    if (to) {
      query += ` ${from ? 'AND' : 'AND'} t.redeemed_at <= $${params.length + 1}`;
      params.push(new Date(to));
    }
    
    query += ' ORDER BY t.redeemed_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(parseInt(limit), offset);
    
    const txRes = await pgPool.query(query, params);
    const countRes = await pgPool.query(
      'SELECT COUNT(*) FROM transactions WHERE merchant_id = $1',
      [payload.sub]
    );
    
    res.json({
      data: txRes.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countRes.rows[0].count)
      }
    });
  } catch (err) {
    if (err.name === 'JsonWebTokenError') {
      res.status(401).json({ result: 'INVALID_TOKEN', message: '로그인이 필요합니다' });
    } else {
      console.error(err);
      res.status(500).json({ result: 'SERVER_ERROR', message: '일시적 오류가 발생했어요' });
    }
  }
});

// Initialize and start server
initialize().catch(err => {
  console.error('Initialization failed:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await redis.quit();
  await pgPool.end();
  httpServer.close(() => {
    console.log('Server gracefully terminated');
    process.exit(0);
  });
});
```