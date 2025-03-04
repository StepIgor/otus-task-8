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

// ROUTES
app.post("/orders", authenticateToken, async (req, res) => {
  // заведение заказа
  const [userId, goodId, deliveryDate, deliveryHour] = [
    req.user.id,
    req.body.goodId,
    req.body.deliveryDate,
    req.body.deliveryHour,
  ];
  if (!userId || !goodId || !deliveryDate || !deliveryHour) {
    return res.status(400).json({
      error: "Проверьте указание goodId, deliveryDate и deliveryHour",
    });
  }
  try {
    // заведение заказа в статусе pending
    const newOrder = await pool
      .query(
        "INSERT INTO orders (UserID, goodID, DeliveryDate, DeliveryHour, Status, Comment) VALUES ($1, $2, $3, $4, 'В обработке', 'Идёт проверка свободной доставки, наличия товара, достатка денежных средств') RETURNING *",
        [userId, goodId, deliveryDate, deliveryHour]
      )
      .then((res) => res.rows[0]);
    // генерация сообщения для сервиса Courier
    publishToQueue("courier_new_order", {
      newOrderId: newOrder.id,
      deliveryDate: newOrder.deliverydate,
      deliveryHour: newOrder.deliveryhour,
      goodId: newOrder.goodid
    });
    res.status(201).json(newOrder);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

app.get("/orders", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const orders = await pool
      .query("SELECT * FROM orders WHERE UserID = $1 ORDER BY ID DESC", [
        userId,
      ])
      .then((res) => res.rows);
    res.status(200).json(orders);
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
