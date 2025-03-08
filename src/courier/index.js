const express = require("express");
const bodyParser = require("body-parser");
const { Pool } = require("pg");
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

const RABBIT_URL = `amqp://${process.env.RABBITMQ_USER}:${process.env.RABBITMQ_PASS}@rabbitmq`;

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

// Чтение сообщений от сервиса Orders (новый заказ)
// Проверяем наличие свободного курьера на указанный час даты
// Генерируем сообщение-подтверждение для Goods или сообщение-отказ для Orders
async function consumeOrdersMessages() {
  try {
    const connection = await amqp.connect(RABBIT_URL);
    const channel = await connection.createChannel();
    await channel.assertQueue("courier_new_order", { durable: true });
    channel.consume("courier_new_order", async (msg) => {
      if (!msg) {
        return;
      }
      const msgContent = JSON.parse(msg.content.toString());
      const theSameHourAndDateOrder = await pool
        .query(
          "SELECT null FROM requests WHERE DeliveryDate = $1 AND DeliveryHour = $2",
          [msgContent.deliveryDate, msgContent.deliveryHour]
        )
        .then((res) => res.rows[0]);
      if (theSameHourAndDateOrder) {
        // уже есть заказ на заданный час и дату, - отказываем
        publishToQueue("orders_order_cancellation", {
          orderId: msgContent.newOrderId,
          reason: "Услуги курьера на указанный час даты недоступны",
        });
        channel.ack(msg);
        return;
      }
      // указанный час даты свободен, бронируем время и подтверждаем передачей сообщения сервису Goods
      await pool.query(
        "INSERT INTO requests (OrderID, DeliveryDate, DeliveryHour) VALUES ($1, $2, $3)",
        [
          msgContent.newOrderId,
          msgContent.deliveryDate,
          msgContent.deliveryHour,
        ]
      );
      publishToQueue("goods_order_creation", {
        orderId: msgContent.newOrderId,
        goodId: msgContent.goodId,
        userId: msgContent.userId,
      });
      channel.ack(msg);
    });
  } catch (err) {
    console.error("Ошибка при подключении к RabbitMQ:", err.message);
  }
}

// Чтение сообщений от сервиса Goods (отмена заказа)
// Заказ нужно отменить (не нашелся товар или нет денег)
// Снимаем резерв с курьера и сообщаем об отмене Orders
async function consumeGoodsMessages() {
  try {
    const connection = await amqp.connect(RABBIT_URL);
    const channel = await connection.createChannel();
    await channel.assertQueue("courier_order_cancellation", { durable: true });
    channel.consume("courier_order_cancellation", async (msg) => {
      if (!msg) {
        return;
      }
      const msgContent = JSON.parse(msg.content.toString());
      await pool.query("DELETE FROM requests WHERE orderid = $1", [
        msgContent.orderId,
      ]);
      publishToQueue("orders_order_cancellation", {
        orderId: msgContent.orderId,
        reason: msgContent.reason,
      });
      channel.ack(msg);
    });
  } catch (err) {
    console.error("Ошибка при подключении к RabbitMQ:", err.message);
  }
}

// Start server
const PORT = process.env.APP_PORT;
app.listen(PORT, () => {
  console.log(`Сервис запущен на http://localhost:${PORT}`);
});

consumeOrdersMessages();
consumeGoodsMessages();
