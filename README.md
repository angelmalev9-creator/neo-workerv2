# NEO Worker v4.0 - Hot Sessions

Браузър worker с hot sessions за мигновено изпълнение на действия.

## Какво е новото в v4

- **Hot Sessions** - браузърът е винаги отворен за всеки сайт
- **SiteMap** - worker-ът знае структурата на сайта предварително
- **Millisecond Response** - без навигация при всяка заявка
- **Backwards Compatible** - поддържа и старите endpoints

## Endpoints

### POST /prepare-session
Подготвя hot session за сайт (извиква се от crawler след training)

```json
{
  "site_id": "uuid",
  "site_map": {
    "url": "https://hotel.com",
    "buttons": [...],
    "forms": [...],
    "prices": [...]
  }
}
```

### POST /execute
Изпълнява действие (извиква се от neo-agent-core)

```json
{
  "site_id": "uuid",
  "keywords": ["резервация", "стая"],
  "data": {
    "check_in": "2025-02-15",
    "check_out": "2025-02-17",
    "guests": 2
  }
}
```

### POST /interact (Legacy)
Backwards compatible с v3.3

### GET /health
Статус на worker-а

## Deploy на Render

1. Създай Web Service с Docker
2. Добави environment variable: `NEO_WORKER_SECRET`
3. Deploy

## Environment Variables

- `NEO_WORKER_SECRET` - Auth token
- `PORT` - Server port (default: 3000)

## Структура

```
├── src/
│   └── worker.ts    # Main worker code
├── Dockerfile
├── package.json
└── tsconfig.json
```
