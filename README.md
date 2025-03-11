ℹ️ В Dockerhub по каждому сервису предусмотрено два контейнера (задаётся через tag):

1. **:latest**, собранные под amd64-архитектуру;
2. **:arm**, собранные под arm64 (M-процессоры Apple);
   
В deploy-манифесты репозитория по умолчанию включены latest-варианты образов.

🧑🏻‍💻 **Порядок установки** (предлагается default namespace, однако можно указать и свой).
1. Разворачиваем PostgreSQL (5 шт., по одному на каждый сервис):
   ```
   helm install authpostgresql bitnami/postgresql -f values/postgresql_values.yaml
   helm install billingpostgresql bitnami/postgresql -f values/postgresql_values.yaml
   helm install orderspostgresql bitnami/postgresql -f values/postgresql_values.yaml
   helm install goodspostgresql bitnami/postgresql -f values/postgresql_values.yaml
   helm install courierpostgresql bitnami/postgresql -f values/postgresql_values.yaml
   ```
2. Устанавливаем RabbitMQ:
   ```
   helm install rabbitmq bitnami/rabbitmq -f values/rabbitmq_values.yaml
   ```
3. Применяем все манифесты одной командой (секрет для базы, миграция, configmap + deploy + service по каждому сервису, ingress):
   ```
   kubectl apply -f manifests/
   ```

ℹ️ Используемся хореографическая сага. Всё взаимодействие сервисов асинхронное через RabbitMQ.

![diag](diag.png)

1. При регистрации пользователя (Auth Service) заводится пустой счёт (Billing Service, баланс = 0). Биллинг читает из очереди billing_new_account;
2. При заведении нового заказа регистрируется запись в состоянии Pending (Orders Service);
3. В Courier Service бронируется указанная дата и час через очередь courier_new_order;
4. Если дата и час свободны, формируется сообщение в очередь goods_order_creation для бронирования выбранного товара (Goods Service);
5. Если товар существует и свободен, осуществляется передача сообщения в очередь billing_order_creation для попытки списания средств за товар (Billing Service);
6. Если деньги успешно списались, генерируется сообщение в очередь orders_order_acception для смены статуса заказа на "accepted" (Orders Service);

Если на одном из этапов что-то идёт не так (курьер уже занят на этот час, товар забронирован или не существует, денег на балансе недостаточно), то генерируются в обратном порядке соответствующие сообщения в очереди-отмены для снятия броней и актуализации статуса заказа (перевод в "cancelled") в конечном счёте.

ℹ️ В директории collections две коллекции, предназначенные для ручного и автоматического использования (manual для "потыкать" и auto для newman соответственно).

Справка насчёт manual: login-запрос автоматически запоминает token, получаемый от сервера, в переменной коллекции, которая затем автоматически подставляется во все необходимые, по части аутентификации, запросы. Чтобы "зайти" под другим пользователем, достаточно повторно вызвать login-запрос с необходимыми name и password. Таким же образом можно и актуализировать токен текущего пользователя (срок действия = 1 час).
