В Dockerhub по каждому сервису предусмотрено два контейнера (задаётся через tag):

1. **:latest**, собранные под amd64-архитектуру;
2. **:arm**, собранные под arm64 (M-процессоры Apple);
   
В deploy-манифесты репозитория по умолчанию включены latest-варианты образов.

**Порядок установки** (предлагается default namespace, однако можно указать и свой).
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
