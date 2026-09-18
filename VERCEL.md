# Развёртывание кабинета рассылок на Vercel

Эта инструкция относится к **новому приложению в корне** папки `elena-pak-trichology`, где лежит `package.json`. Папка `greenHouse` — другой проект. Развёртывание здесь не выполнялось: для него нужны ваши аккаунты GitHub, Vercel, PostgreSQL и GreenAPI.

## 1. Подготовьте отдельную базу и GreenAPI

Создайте **новую базу PostgreSQL для этого приложения**. Например, в Neon создайте проект, нажмите **Connect** и скопируйте строку подключения `postgresql://...`. Для этого небольшого служебного приложения можно использовать прямое подключение; для миграций оно подходит без дополнительной настройки. Не используйте `DATABASE_URL` проекта `greenHouse`.

В [кабинете GreenAPI](https://green-api.com/docs/before-start/) создайте и авторизуйте WhatsApp-инстанс, затем скопируйте именно его `apiUrl`, `idInstance` и `apiTokenInstance`. Инстанс должен быть подключён к WhatsApp до тестовой отправки. Не публикуйте токен и строку подключения в GitHub или сообщениях.

## 2. Разместите код в отдельном репозитории GitHub

Сейчас Git-репозиторий есть только внутри `greenHouse`; у нового приложения в корне его нет. Создайте в GitHub **новый приватный пустой репозиторий** без автоматически добавляемого README. В PowerShell из корня проекта выполните, подставив адрес своего репозитория:

```powershell
git init
git add .
git status --short
git commit -m "Initial mailer app"
git branch -M main
git remote add origin https://github.com/ВАШ_АККАУНТ/ВАШ_РЕПОЗИТОРИЙ.git
git push -u origin main
```

Перед `git commit` проверьте вывод `git status --short`: там не должно быть `.env`, Excel/CSV клиентов, `index.html`, `node_modules` или `greenHouse`. Это уже настроено в корневом `.gitignore`. Репозиторий `greenHouse` останется отдельным.

## 3. Импортируйте проект в Vercel

1. В панели Vercel выберите **Add New → Project**, подключите GitHub при необходимости и импортируйте только что созданный репозиторий.
2. **Framework Preset:** `Next.js`.
3. **Root Directory:** корень репозитория, то есть `./`. **Не** выбирайте `greenHouse`.
4. **Build Command:** включите переопределение и укажите `npm run vercel-build`. Эта команда выполняет `prisma migrate deploy`, затем `next build`. При установке пакетов скрипт `postinstall` автоматически генерирует Prisma Client.
5. **Install Command** и **Output Directory:** оставьте значения по умолчанию.
6. **Node.js Version:** `24.x` в **Project Settings → Build and Deployment**, если Vercel не выбрал её автоматически.

## 4. Укажите переменные окружения

До первого **Deploy** добавьте в форме импорта или затем в **Project Settings → Environment Variables** следующие значения. В интерфейсе Vercel вводите имя и значение в отдельных полях, **без кавычек** из `.env.example`:

| Name                    | Value                            | Где взять                                           |
| ----------------------- | -------------------------------- | --------------------------------------------------- |
| `DATABASE_URL`          | Полная строка `postgresql://...` | **Connect** в панели вашей новой базы Postgres/Neon |
| `ADMIN_PASSWORD`        | Сложный пароль от 12 символов    | Придумайте для сотрудников                          |
| `SESSION_SECRET`        | Случайная строка от 32 символов  | Сгенерируйте командой ниже                          |
| `GREEN_API_URL`         | `apiUrl` инстанса                | Кабинет GreenAPI                                    |
| `GREEN_API_ID_INSTANCE` | `idInstance`                     | Кабинет GreenAPI                                    |
| `GREEN_API_TOKEN`       | `apiTokenInstance`               | Кабинет GreenAPI                                    |
| `SEND_BATCH_SIZE`       | `5`                              | Необязательно; максимум 5                           |
| `SEND_DELAY_MS`         | `700`                            | Необязательно; пауза в миллисекундах                |

Для `SESSION_SECRET` выполните локально:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Добавьте эти переменные в окружение **Production**. Секреты называются без префикса `NEXT_PUBLIC_` и остаются на сервере. Если будете использовать **Preview**-деплои, задайте для Preview **другую базу**, отдельный пароль и секрет; для тестовой отправки — отдельный GreenAPI-инстанс. Не указывайте производственную базу в Preview: команда сборки применяет миграции к базе соответствующего окружения. [Prisma о Preview-базах](https://www.prisma.io/docs/orm/v7/prisma-client/deployment/serverless/deploy-to-vercel)

## 5. Разверните и проверьте

Нажмите **Deploy**. В логах сборки должны успешно завершиться `prisma generate`, `prisma migrate deploy` и `next build`. Если переменные добавляли **после** первой попытки сборки, сделайте **Redeploy**: Vercel применяет изменённые переменные к новому развёртыванию.

Откройте выданный Vercel адрес `https://...vercel.app`:

1. Войдите с `ADMIN_PASSWORD`.
2. Загрузите Excel и проверьте предпросмотр, не начиная массовую рассылку.
3. Проверьте реальную отправку сначала на **один свой номер**.
4. Убедитесь, что запись появилась в журнале и CSV-отчёте.

Если вход возвращает ошибку сервера, проверьте `DATABASE_URL`, миграцию и `ADMIN_PASSWORD` в Vercel. Если отправка не стартует, проверьте все три `GREEN_API_*` и состояние авторизации инстанса.

Приложение уже защищает страницу и API своим паролем. Дополнительная **Vercel Authentication → All Deployments** доступна как второй рубеж, если все сотрудники имеют доступ к проекту Vercel; для обычного входа по паролю она не нужна. [Документация Vercel](https://vercel.com/changelog/protect-production-deployments-for-free-on-every-plan)

## Обновления

После изменения кода отправляйте новый коммит в ветку `main`: Vercel создаст новое production-развёртывание. Если добавлены миграции Prisma, `npm run vercel-build` применит их к Production-базе во время сборки. Сначала проверяйте изменения и новые шаблоны на тестовых номерах.
