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

// Чтение сообщений от сервиса Courier (продолжение цепочки обработки заказа)
// Бронируем товар и передаём запрос списание в Billing или отказываем и сообщаем обратно Courier
async function consumeCourierMessages() {
  try {
    const connection = await amqp.connect(RABBIT_URL);
    const channel = await connection.createChannel();
    await channel.assertQueue("goods_order_creation", { durable: true });
    channel.consume("goods_order_creation", async (msg) => {
      if (!msg) {
        return;
      }
      const msgContent = JSON.parse(msg.content.toString());
      const good = await pool
        .query("SELECT * FROM goods WHERE id = $1", [msgContent.goodId])
        .then((res) => res.rows[0]);
      if (!good) {
        // такого товара нет в базе, отказ
        publishToQueue("courier_order_cancellation", {
          orderId: msgContent.orderId,
          reason: "Товар не обнаружен на складе",
        });
        channel.ack(msg);
        return;
      }
      if (good.occupierid) {
        // товар уже зарезервирован по другому заказу, отказ
        publishToQueue("courier_order_cancellation", {
          orderId: msgContent.orderId,
          reason: "Товар уже зарезервирован другим заказом",
        });
        channel.ack(msg);
        return;
      }
      // всё ок, товар есть и свободен, делаем резерв
      await pool.query("UPDATE goods SET occupierid = $2 WHERE id = $1", [
        msgContent.goodId,
        msgContent.userId,
      ]);
      // сообщаем Billing, что нужно попытаться списать средства за товар
      publishToQueue("billing_order_creation", {
        userId: msgContent.userId,
        price: good.price,
      });
      channel.ack(msg);
    });
  } catch (err) {
    console.error("Ошибка при подключении к RabbitMQ:", err.message);
  }
}

// ROUTES
app.get("/goods", authenticateToken, async (req, res) => {
  try {
    const goods = await pool
      .query("SELECT * FROM goods WHERE occupierid is null ORDER BY id DESC")
      .then((res) => res.rows);
    res.status(200).json(goods);
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

consumeCourierMessages();
