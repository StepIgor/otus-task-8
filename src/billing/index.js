const express = require("express");
const bodyParser = require("body-parser");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const amqp = require("amqplib");

const app = express();
app.use(bodyParser.json());

// Database configuration
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PSWD,
  port: process.env.DB_PORT,
});

const JWT_SECRET = process.env.JWT_SECRET;
const RABBIT_URL = `amqp://${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASS}@rabbitmq`;

// Middleware для проверки JWT-токена
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) {
    return res.status(403).json({ error: "Отказ в доступе. Нет токена" });
  }
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res
        .status(403)
        .json({ error: "Отказ в доступе. Некорректный токен" });
    }
    req.user = user;
    next();
  });
};

// Отправка сообщений в RabbitMQ
async function publishToQueue(queue, message) {
  try {
    const connection = await amqp.connect(RABBIT_URL);
    const channel = await connection.createChannel();
    await channel.assertQueue(queue, { durable: true });
    channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)), {
      persistent: true,
    });
    await channel.close();
    await connection.close();
  } catch (error) {
    console.error("Ошибка отправки сообщения в RabbitMQ:", error.message);
  }
}

// Чтение сообщений от сервиса Orders (открытие пустого счета на нового клиента)
// Добавляем запись с нулевым балансом
async function consumeOrdersMessages() {
  try {
    const connection = await amqp.connect(RABBIT_URL);
    const channel = await connection.createChannel();
    await channel.assertQueue("billing_new_account", { durable: true });
    channel.consume("billing_new_account", async (msg) => {
      if (!msg) {
        return;
      }
      const msgContent = JSON.parse(msg.content.toString());
      await pool.query("INSERT INTO accounts (userid, amount) VALUES ($1, 0)", [
        msgContent.newUserId,
      ]);
      channel.ack(msg);
    });
  } catch (err) {
    console.error("Ошибка при подключении к RabbitMQ:", err.message);
  }
}

// Чтение сообщений от сервиса Goods (заключительное звено цепочки обработки заказа)
// Пытаемся списать денежные средства
async function consumeGoodsMessages() {
  try {
    const connection = await amqp.connect(RABBIT_URL);
    const channel = await connection.createChannel();
    await channel.assertQueue("billing_order_creation", { durable: true });
    channel.consume("billing_order_creation", async (msg) => {
      if (!msg) {
        return;
      }
      const msgContent = JSON.parse(msg.content.toString());
      const userAccount = await pool
        .query("SELECT amount FROM accounts WHERE userid = $1", [
          msgContent.userId,
        ])
        .then((res) => res.rows[0]);
      const currentBalance = userAccount?.amount || 0;
      if (currentBalance < msgContent.price) {
        publishToQueue("goods_order_cancellation", {
          orderId: msgContent.orderId,
          goodId: msgContent.goodId,
          reason: "Недостаточно средств на балансе пользователя",
        });
        channel.ack(msg);
        return;
      }
      await pool.query(
        "UPDATE accounts SET amount = amount - $2 WHERE userId = $1",
        [msgContent.userId, msgContent.price]
      );
      publishToQueue("orders_order_acception", {
        orderId: msgContent.orderId,
      });
      channel.ack(msg);
    });
  } catch (err) {
    console.error("Ошибка при подключении к RabbitMQ:", err.message);
  }
}

// ROUTES
app.post("/topup", authenticateToken, async (req, res) => {
  const [userId, amount] = [req.user.id, req.body.amount];
  if (!userId || !amount) {
    res.status(400).json({ error: "Не все данные указаны (userId, amount)" });
    return;
  }
  try {
    const queryResult = await pool.query(
      "SELECT amount FROM accounts WHERE userid = $1",
      [userId]
    );
    if (!queryResult?.rows?.length) {
      res.status(404).json({ error: "Аккаунта пополнения не существует" });
      return;
    }
    const newAmountData = await pool.query(
      "UPDATE accounts SET amount = amount + $1 WHERE userid = $2 RETURNING *",
      [amount, userId]
    );
    res.status(200).json(newAmountData.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

app.get("/balance", authenticateToken, async (req, res) => {
  try {
    const amount = await pool
      .query("SELECT amount FROM accounts WHERE userid = $1", [req.user.id])
      .then((res) => res.rows[0].amount);
    res.status(200).json({ amount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

// Start server
const PORT = process.env.APP_PORT;
app.listen(PORT, () => {
  console.log(`Сервис запущен на http://localhost:${PORT}`);
});

consumeOrdersMessages();
consumeGoodsMessages();
