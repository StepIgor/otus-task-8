const express = require("express");
const bodyParser = require("body-parser");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const amqp = require("amqplib");
const crypto = require("crypto");

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

// Чтение сообщений от сервиса Courier (если отмена заказа)
// Меняем статус заказа на окончательный (pending -> cancelled)
async function consumeCourierMessages() {
  try {
    const connection = await amqp.connect(RABBIT_URL);
    const channel = await connection.createChannel();
    await channel.assertQueue("orders_order_cancellation", { durable: true });
    channel.consume("orders_order_cancellation", async (msg) => {
      // отказ (нет курьера/товара/денег), уводим заказ в cancelled
      if (!msg) {
        return;
      }
      const msgContent = JSON.parse(msg.content.toString());
      await pool.query(
        "UPDATE orders SET status = $2, comment = $3 WHERE id = $1",
        [msgContent.orderId, "cancelled", msgContent.reason]
      );
      channel.ack(msg);
    });
  } catch (err) {
    console.error("Ошибка при подключении к RabbitMQ:", err.message);
  }
}

// Чтение сообщений от сервиса Billing (успех по заказу)
// Меняем статус заказа на окончательный (pending -> accepted)
async function consumeBillingMessages() {
  try {
    const connection = await amqp.connect(RABBIT_URL);
    const channel = await connection.createChannel();
    await channel.assertQueue("orders_order_acception", { durable: true });
    channel.consume("orders_order_acception", async (msg) => {
      if (!msg) {
        return;
      }
      const msgContent = JSON.parse(msg.content.toString());
      await pool.query(
        "UPDATE orders SET status = $2, comment = $3 WHERE id = $1",
        [
          msgContent.orderId,
          "accepted",
          "Успех! Время забронировано, товар зарезервирован, деньги списаны! Передаём в доставку!",
        ]
      );
      channel.ack(msg);
    });
  } catch (err) {
    console.error("Ошибка при подключении к RabbitMQ:", err.message);
  }
}

// генерация FingerPrint для нового заказа с клиента
function generateFingerprint(userId, goodId, deliveryDate, deliveryHour) {
  return crypto
    .createHash("sha256")
    .update(`${userId}-${goodId}-${deliveryDate}-${deliveryHour}`)
    .digest("hex");
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
  const dbClient = await pool.connect();
  try {
    const fingerPrint = generateFingerprint(
      userId,
      goodId,
      deliveryDate,
      deliveryHour
    );
    const existingFingerPrint = await dbClient
      .query("SELECT orderid FROM fingerprints WHERE fingerprint = $1", [
        fingerPrint,
      ])
      .then((res) => res.rows[0]);
    if (existingFingerPrint) {
      // Заказ уже создан пользователем ранее
      const existingOrder = await dbClient.query(
        "SELECT * FROM orders WHERE id = $1",
        [existingFingerPrint.orderid]
      ).then(res => res.rows);
      // Отдаём 200, а не 201, как обычно, чтобы клиент понял, что заказ не задублировался
      return res.status(200).json(existingOrder);
    }

    // заведение заказа в статусе pending
    await dbClient.query("BEGIN"); // начинаем транзакцию
    const newOrder = await dbClient
      .query(
        "INSERT INTO orders (UserID, goodID, DeliveryDate, DeliveryHour, Status, Comment) VALUES ($1, $2, $3, $4, 'pending', 'Идёт проверка свободной доставки, наличия товара, достатка денежных средств') RETURNING *",
        [userId, goodId, deliveryDate, deliveryHour]
      )
      .then((res) => res.rows[0]);
    // генерация сообщения для сервиса Courier
    publishToQueue("courier_new_order", {
      newOrderId: newOrder.id,
      deliveryDate: newOrder.deliverydate,
      deliveryHour: newOrder.deliveryhour,
      goodId: newOrder.goodid,
      userId: userId,
    });
    // регистрация fingerprint
    await dbClient.query(
      "INSERT INTO fingerprints (fingerprint, orderid) VALUES ($1, $2)",
      [fingerPrint, newOrder.id]
    );
    await dbClient.query("COMMIT"); // закрыть транзакцию
    return res.status(201).json(newOrder);
  } catch (err) {
    await dbClient.query("ROLLBACK"); // откат транзакции
    console.error(err);
    res.status(500).json({ error: "Внутренняя ошибка сервера" });
  } finally {
    dbClient.release(); // освобождаем клиент
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

consumeCourierMessages();
consumeBillingMessages();
