Собери in-memory Todo JSON API на `Bun.serve` в `index.ts`. Порт берётся из флага `--port` (по умолчанию 3000). Эндпоинты:
  `POST   /todos`      тело `{"title": string}` -> 200, JSON `{"id": string, "title": string}`
  `GET    /todos`      -> 200, JSON-массив всех todo
  `DELETE /todos/:id`  -> 204 (или 200), удаляет
Хранение в памяти. Перед началом работы выполни `bun install`, чтобы подтянуть `typescript`/`bun-types` из `package.json`. Проверь сам: `bunx tsc --noEmit --strict` чисто, сервер поднимается, эндпоинты отвечают.
