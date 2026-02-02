# 🚀 NEO WORKER - Пълен Setup Guide

## 📋 Съдържание
1. [Как работи системата](#как-работи-системата)
2. [Какво ти трябва](#какво-ти-трябва)
3. [Стъпка 1: Deploy на Render](#стъпка-1-deploy-на-render)
4. [Стъпка 2: Supabase Edge Function](#стъпка-2-supabase-edge-function)
5. [Стъпка 3: Свързване с NEO Agent](#стъпка-3-свързване-с-neo-agent)
6. [Стъпка 4: Тестване](#стъпка-4-тестване)
7. [Как NEO ще го ползва](#как-neo-ще-го-ползва)

---

## 🧠 Как работи системата

### Голямата картина

```
┌────────────────────────────────────────────────────────────────────────────┐
│                              КЛИЕНТ                                         │
│                    "Искам да резервирам стая в Hotel X"                     │
└─────────────────────────────────┬──────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                         NEO AGENT CORE                                      │
│                      (Supabase Edge Function)                               │
│                                                                             │
│   1. Получава съобщение от клиента                                          │
│   2. Разбира че трябва да провери наличност                                 │
│   3. Вика execute-action с команди                                          │
└─────────────────────────────────┬──────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                        EXECUTE-ACTION                                       │
│                     (Supabase Edge Function)                                │
│                                                                             │
│   1. Получава команда (open, look, click...)                                │
│   2. Праща към NEO Worker на Render                                         │
│   3. Връща резултата обратно                                                │
└─────────────────────────────────┬──────────────────────────────────────────┘
                                  │
                                  │ HTTPS / WebSocket
                                  ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                          NEO WORKER                                         │
│                        (Render Server)                                      │
│                                                                             │
│   ┌──────────────────────────────────────────────────────────────────┐     │
│   │                    PERSISTENT BROWSER                             │     │
│   │                   (Chromium - винаги отворен)                     │     │
│   │                                                                   │     │
│   │   Команда: "open hotel.bg"                                        │     │
│   │   → Отваря сайта                                                  │     │
│   │   → Връща: "Готово, виждам страницата"                            │     │
│   │                                                                   │     │
│   │   Команда: "look"                                                 │     │
│   │   → Сканира какво има                                             │     │
│   │   → Връща: "Виждам бутон 'Резервирай', поле за дати"              │     │
│   │                                                                   │     │
│   │   Команда: "click Резервирай"                                     │     │
│   │   → Кликва върху бутона                                           │     │
│   │   → Връща: "Кликнах, отвори се форма"                             │     │
│   └──────────────────────────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────────────────────────┘
```

### Защо е по-бързо?

```
СТАРИЯТ НАЧИН (бавен):
══════════════════════════════════════════════════════════════
Заявка → Стартирай браузър → Зареди → Работи → Затвори браузър → Отговор
         |____2-3 сек____|   |_1s_|  |_2-3s_|  |____0.5s____|
                          ОБЩО: 5-10 секунди
══════════════════════════════════════════════════════════════

НОВИЯТ НАЧИН (бърз):
══════════════════════════════════════════════════════════════
Заявка → Браузърът вече е отворен → Работи → Отговор
                    |_____0s_____|   |_1-2s_|
                          ОБЩО: 1-2 секунди
══════════════════════════════════════════════════════════════
```

---

## 📦 Какво ти трябва

### Акаунти:
- [x] **Render.com** акаунт (безплатен план работи)
- [x] **Supabase** акаунт (вече го имаш)
- [x] **GitHub** акаунт (за deploy)

### Файлове (вече ги имаш в zip-а):
```
neo-worker/
├── src/
│   └── worker.ts           ← Главният worker файл
├── supabase/
│   └── execute-action.ts   ← Новата edge function
├── package.json
├── tsconfig.json
├── Dockerfile
└── README.md
```

---

## 🔧 Стъпка 1: Deploy на Render

### 1.1 Качи кода в GitHub

```bash
# Създай ново repo в GitHub, после:
cd neo-worker
git init
git add .
git commit -m "Initial commit - Neo Worker"
git branch -M main
git remote add origin https://github.com/ТВОЕТО_ИМЕ/neo-worker.git
git push -u origin main
```

### 1.2 Създай Web Service в Render

1. Отиди на **https://render.com**
2. Кликни **"New +"** → **"Web Service"**
3. Свържи GitHub repo-то `neo-worker`
4. Настройки:

```
Name:           neo-worker
Region:         Frankfurt (EU Central)  ← най-близо до България
Branch:         main
Root Directory: (остави празно)
Runtime:        Docker

Instance Type:  Free (или Starter за по-добра производителност)
```

5. Environment Variables:
```
PORT = 3000
```

6. Кликни **"Create Web Service"**

### 1.3 Изчакай deploy-а

- Render ще build-не Docker image-а
- Ще инсталира Playwright + Chromium
- Отнема ~3-5 минути първия път

### 1.4 Провери че работи

Когато е готово, ще имаш URL като:
```
https://neo-worker.onrender.com
```

Отвори го в браузър - трябва да видиш:
```json
{
  "status": "ok",
  "service": "neo-worker",
  "mode": "persistent"
}
```

---

## 🔧 Стъпка 2: Supabase Edge Function

### 2.1 Добави environment variable

В Supabase Dashboard:
1. **Settings** → **Edge Functions**
2. Добави secret:
```
NEO_WORKER_URL = https://neo-worker.onrender.com
```

### 2.2 Deploy новата execute-action функция

```bash
# В твоя Supabase проект
cd supabase/functions

# Създай нова папка (или замени старата)
mkdir -p execute-action

# Копирай новия файл
cp /path/to/neo-worker/supabase/execute-action.ts execute-action/index.ts

# Deploy
supabase functions deploy execute-action
```

### 2.3 Алтернативно: Ръчно от Dashboard

1. Supabase Dashboard → **Edge Functions**
2. Намери `execute-action`
3. Кликни **Edit**
4. Замени кода с новия от `execute-action.ts`
5. **Save & Deploy**

---

## 🔧 Стъпка 3: Свързване с NEO Agent

### 3.1 Как NEO Agent Core ще вика worker-а

В `neo-agent-core/index.ts`, когато трябва да провериш наличност:

```typescript
// СТАР КОД (изтрий):
const result = await fetch("/functions/v1/execute-action", {
  method: "POST",
  body: JSON.stringify({
    type: "autoAvailability",
    payload: { url: siteUrl }
  })
});

// НОВ КОД (добави):
async function checkAvailability(siteUrl: string) {
  // 1. Отвори сайта
  await fetch("/functions/v1/execute-action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      command: "open",
      url: siteUrl
    })
  });

  // 2. Виж какво има
  const lookResult = await fetch("/functions/v1/execute-action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      command: "look"
    })
  });

  const data = await lookResult.json();
  return data;
}
```

### 3.2 Пълен пример за интеграция

```typescript
// В neo-agent-core, когато засечеш intent = "check_availability"

async function handleAvailabilityCheck(siteUrl: string, userRequest: string) {
  const steps: string[] = [];
  
  // 1. ОТВОРИ САЙТА
  const openResult = await callWorker({ 
    command: "open", 
    url: siteUrl 
  });
  steps.push(openResult.message);
  
  // 2. СКАНИРАЙ
  const lookResult = await callWorker({ 
    command: "look" 
  });
  steps.push(lookResult.message);
  
  // 3. АКО ИМА БУТОН ЗА НАЛИЧНОСТ - КЛИКНИ
  const buttons = lookResult.data?.buttons || [];
  const availabilityButton = buttons.find(b => 
    /наличност|availability|check|провери|search/i.test(b.text)
  );
  
  if (availabilityButton) {
    const clickResult = await callWorker({
      command: "click",
      target: availabilityButton.selector
    });
    steps.push(clickResult.message);
    
    // 4. СКАНИРАЙ ОТНОВО
    const afterClick = await callWorker({ command: "look" });
    steps.push(afterClick.message);
    
    return {
      success: true,
      steps,
      data: afterClick.data
    };
  }
  
  return {
    success: true,
    steps,
    data: lookResult.data
  };
}

// Helper функция
async function callWorker(command: any) {
  const response = await fetch(
    `${Deno.env.get("SUPABASE_URL")}/functions/v1/execute-action`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}`
      },
      body: JSON.stringify(command)
    }
  );
  return response.json();
}
```

---

## 🔧 Стъпка 4: Тестване

### 4.1 Тествай Worker-а директно

```bash
# Провери дали е жив
curl https://neo-worker.onrender.com/health

# Отвори сайт
curl -X POST https://neo-worker.onrender.com/command \
  -H "Content-Type: application/json" \
  -d '{"action": "open", "url": "https://google.com"}'

# Виж какво има
curl -X POST https://neo-worker.onrender.com/command \
  -H "Content-Type: application/json" \
  -d '{"action": "look"}'
```

### 4.2 Тествай през Supabase

```bash
# През execute-action
curl -X POST https://YOUR_PROJECT.supabase.co/functions/v1/execute-action \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -d '{"command": "open", "url": "https://booking.com"}'
```

### 4.3 Тествай с реален хотелски сайт

```javascript
// Тестов скрипт
const commands = [
  { command: "open", url: "https://some-hotel.bg/reservations" },
  { command: "look" },
  { command: "click", target: "Провери наличност" },
  { command: "look" }
];

for (const cmd of commands) {
  console.log(`\n>>> ${cmd.command} ${cmd.url || cmd.target || ""}`);
  const response = await fetch("/functions/v1/execute-action", {
    method: "POST",
    body: JSON.stringify(cmd)
  });
  const result = await response.json();
  console.log(result.message);
}
```

---

## 🎯 Как NEO ще го ползва

### Сценарий 1: Проверка на наличност

```
Клиент: "Има ли свободни стаи в Хотел Родина за 15-17 март?"

NEO (мисли): 
  → Intent: check_availability
  → Имам URL на хотела от базата
  → Трябва да проверя

NEO → Worker:
  1. open("https://hotelrodina.bg/booking")
  2. look()  
     ← "Виждам: календар, поле за гости, бутон 'Търси'"
  3. fill("checkin", "2024-03-15")
  4. fill("checkout", "2024-03-17")
  5. click("Търси")
  6. look()
     ← "Виждам: 3 свободни стаи - Двойна 120лв, Апартамент 180лв"

NEO → Клиент: "Да, има 3 свободни стаи! Двойна стая е 120лв на нощ,
               а апартамент - 180лв. Искате ли да резервирам?"
```

### Сценарий 2: Резервация

```
Клиент: "Да, резервирай двойната стая. Името ми е Иван Петров, 
         имейл ivan@mail.bg"

NEO → Worker:
  1. click("Двойна стая")  или  click("Резервирай") до двойната
  2. look()
     ← "Виждам форма: име, имейл, телефон"
  3. fill("name", "Иван Петров")
  4. fill("email", "ivan@mail.bg")
  5. look()  // провери преди submit
     ← "Формата е попълнена, виждам бутон 'Потвърди'"
  6. submit()
  7. look()
     ← "Виждам: 'Резервацията е успешна! Номер: 12345'"

NEO → Клиент: "Готово! Резервирах ви двойна стая. Ще получите 
               потвърждение на ivan@mail.bg. Номер на резервацията: 12345"
```

### Сценарий 3: Грешка / Проблем

```
Клиент: "Провери наличност в HotelX.bg"

NEO → Worker:
  1. open("https://hotelx.bg/booking")
     ← success: false, error: "Timeout - сайтът не отговаря"

NEO → Клиент: "За съжаление сайтът на хотела не отговаря в момента. 
               Искате ли да опитам пак след малко или да ви дам 
               телефона им за директна връзка?"
```

---

## 🔄 Workflow диаграма

```
┌─────────────────────────────────────────────────────────────────────┐
│                         КЛИЕНТ ГОВОРИ                                │
│              "Искам да резервирам стая за 2 нощи"                    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      GEMINI SESSION                                  │
│                 (гласова сесия с клиента)                            │
│                                                                      │
│  Получава глас → Транскрибира → Праща към NEO Agent Core             │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      NEO AGENT CORE                                  │
│                                                                      │
│  1. detectIntent() → "booking_request"                               │
│  2. extractEntities() → { nights: 2 }                                │
│  3. Нямам дати → питам клиента                                       │
│     ИЛИ                                                              │
│  3. Имам всичко → викам Worker                                       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      EXECUTE-ACTION                                  │
│                                                                      │
│  Получава: { command: "open", url: "..." }                           │
│  Праща към Worker                                                    │
│  Връща резултат                                                      │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        NEO WORKER                                    │
│                    (Render + Playwright)                             │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ BROWSER                                                      │    │
│  │                                                              │    │
│  │ open()  → Зарежда URL                                        │    │
│  │ look()  → Сканира DOM, връща бутони/полета                   │    │
│  │ click() → Кликва елемент                                     │    │
│  │ fill()  → Попълва поле                                       │    │
│  │ submit()→ Изпраща форма                                      │    │
│  └─────────────────────────────────────────────────────────────┘    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
                          РЕЗУЛТАТ
                    (бутони, цени, стаи)
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      NEO AGENT CORE                                  │
│                                                                      │
│  Получава резултат → Форматира отговор                               │
│  "Има 3 свободни стаи..."                                            │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         КЛИЕНТ ЧУВА                                  │
│         "Има 3 свободни стаи! Двойна е 120лв на нощувка."           │
└─────────────────────────────────────────────────────────────────────┘
```

---

## ⚠️ Важни неща

### 1. Render Free Plan ограничения
- Сървърът "заспива" след 15 минути без заявки
- Първата заявка след sleep отнема ~30 секунди
- **Решение**: Upgrade на Starter план ($7/месец) или cron job да го буди

### 2. Браузърът има лимитирана памет
- Ако не затваряш страници, паметта расте
- **Решение**: Викай `close` след всяка сесия, или рестартирай worker-а периодично

### 3. Някои сайтове блокират автоматизация
- CAPTCHA, bot detection
- **Решение**: look() ще ти каже ако има проблем, NEO може да каже на клиента да резервира ръчно

---

## 📝 Чеклист за Setup

```
[ ] 1. GitHub repo създадено
[ ] 2. Код push-нат
[ ] 3. Render Web Service създаден
[ ] 4. Render deploy успешен
[ ] 5. Worker /health отговаря
[ ] 6. Supabase NEO_WORKER_URL добавен
[ ] 7. execute-action deploy-ната
[ ] 8. Тест: open + look работи
[ ] 9. neo-agent-core свързан
[ ] 10. End-to-end тест с клиент
```

---

## 🆘 Troubleshooting

### "Worker не отговаря"
1. Провери Render logs
2. Провери дали build-ът е минал
3. Провери PORT environment variable

### "Timeout при open"
1. Сайтът може да е бавен
2. Увеличи timeout в worker.ts (ред 95)
3. Провери дали сайтът изобщо работи

### "Click не намира елемент"
1. Провери look() какво връща
2. Използвай точния selector от look()
3. Може елементът да е в iframe

### "Render заспива"
1. Upgrade на платен план
2. Или добави cron job да пинга /health на всеки 10 минути

---

Готов си! 🚀
