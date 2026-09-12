const SUPPORT_ID = "1019a3fd516d4ce1b67df99e3133c46a";
const SESSION_COOKIE = "__Host-scoffe2_session";

const PLAN_QUOTAS = {
  flash: {
    text: 50,
    image: 1,
    video: 1,
    rerank: 10
  },
  home: {
    text: 150,
    image: 2,
    video: 1,
    rerank: 30
  }
};

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "X-Scoffe2-Handler": "support-v1"
    }
  });
}

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );

  return Array.from(
    new Uint8Array(digest),
    byte => byte.toString(16).padStart(2, "0")
  ).join("");
}

function readSessionToken(request) {
  const cookies = request.headers.get("Cookie") || "";

  for (const part of cookies.split(";")) {
    const item = part.trim();
    const prefix = SESSION_COOKIE + "=";

    if (!item.startsWith(prefix)) continue;

    const token = item.slice(prefix.length);

    if (/^[0-9a-f]{64}$/.test(token)) {
      return token;
    }
  }

  return null;
}

async function authenticateSupport(db, request) {
  const token = readSessionToken(request);

  if (!token) {
    throw new ApiError(401, "Нужно войти в аккаунт.");
  }

  const tokenHash = await sha256(token);
  const now = Math.floor(Date.now() / 1000);

  const user = await db.prepare(`
    SELECT u.id
    FROM users u
    JOIN sessions s ON s.user_id = u.id
    WHERE s.token_hash = ?
      AND s.expires_at > ?
  `).bind(tokenHash, now).first();

  if (!user) {
    throw new ApiError(
      401,
      "Сессия истекла. Войди в аккаунт снова."
    );
  }

  // Права определяются по серверной сессии.
  // ID, присланный браузером, не используется для авторизации.
  if (user.id !== SUPPORT_ID) {
    throw new ApiError(
      403,
      "Панель доступна только аккаунту поддержки."
    );
  }

  return user;
}

async function readJSON(request) {
  const contentType = (
    request.headers.get("Content-Type") || ""
  ).split(";")[0].trim().toLowerCase();

  if (contentType !== "application/json") {
    throw new ApiError(
      415,
      "Ожидается запрос application/json."
    );
  }

  if (!request.body) {
    throw new ApiError(400, "Пустой запрос.");
  }

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      size += value.byteLength;

      if (size > 2048) {
        await reader.cancel().catch(() => {});

        throw new ApiError(
          413,
          "Слишком большой запрос."
        );
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder(
      "utf-8",
      { fatal: true }
    ).decode(bytes);

    const body = JSON.parse(text);

    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body)
    ) {
      throw new Error();
    }

    return body;
  } catch {
    throw new ApiError(400, "Некорректный JSON.");
  }
}

async function checkRateLimit(db, supportId) {
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / 60);
  const key = `support-give:${supportId}:${bucket}`;

  const result = await db.prepare(`
    INSERT INTO rate_limits (key, count, expires_at)
    VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE
    SET count = count + 1
    WHERE count < 10
    RETURNING count
  `).bind(
    key,
    (bucket + 1) * 60
  ).first();

  if (!result) {
    throw new ApiError(
      429,
      "Слишком много команд. Подожди минуту и повтори."
    );
  }
}

function parseCommand(body) {
  if (
    typeof body.requestId !== "string" ||
    !/^[0-9a-f]{32}$/.test(body.requestId)
  ) {
    throw new ApiError(
      400,
      "Некорректный идентификатор операции."
    );
  }

  if (
    typeof body.command !== "string" ||
    body.command.length > 200
  ) {
    throw new ApiError(400, "Некорректная команда.");
  }

  const command = body.command.trim().normalize("NFKC");

  const match = command.match(
    /^\.\$give\s+([0-9a-f]{32})\s+(flash|home|флэш|домашний)\s+([1-9]|1[0-2])$/iu
  );

  if (!match) {
    throw new ApiError(
      400,
      "Формат: .$give ID_ПОЛЬЗОВАТЕЛЯ flash|home 1–12"
    );
  }

  const label = match[2].toLowerCase();

  return {
    requestId: body.requestId,
    userId: match[1].toLowerCase(),
    plan: label === "flash" || label === "флэш"
      ? "flash"
      : "home",
    months: Number(match[3])
  };
}

async function givePlan(db, support, request) {
  await checkRateLimit(db, support.id);

  const body = await readJSON(request);
  const command = parseCommand(body);

  const target = await db.prepare(`
    SELECT id
    FROM users
    WHERE id = ?
  `).bind(command.userId).first();

  if (!target) {
    throw new ApiError(
      404,
      "Пользователь с таким ID не найден."
    );
  }

  const quota = PLAN_QUOTAS[command.plan];
  const now = Math.floor(Date.now() / 1000);

  /*
    Начисление выполняет SQL-триггер apply_support_grant.

    Повторный request_id не создаёт новую запись.
    Значит, повтор той же операции не начисляет тариф ещё раз.
  */
  const inserted = await db.prepare(`
    INSERT INTO support_grants (
      request_id,
      support_id,
      user_id,
      plan,
      months,
      text_quota,
      image_quota,
      video_quota,
      rerank_quota,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(request_id) DO NOTHING
  `).bind(
    command.requestId,
    support.id,
    target.id,
    command.plan,
    command.months,
    quota.text * command.months,
    quota.image * command.months,
    quota.video * command.months,
    quota.rerank * command.months,
    now
  ).run();

  const grant = await db.prepare(`
    SELECT g.*, u.username
    FROM support_grants g
    JOIN users u ON u.id = g.user_id
    WHERE g.request_id = ?
  `).bind(command.requestId).first();

  if (!grant) {
    throw new ApiError(
      500,
      "Не удалось подтвердить выдачу. Повтори ту же операцию."
    );
  }

  if (
    grant.support_id !== support.id ||
    grant.user_id !== command.userId ||
    grant.plan !== command.plan ||
    Number(grant.months) !== command.months
  ) {
    throw new ApiError(
      409,
      "Этот идентификатор уже использован для другой команды."
    );
  }

  // Не сообщаем об успехе, если триггер не заполнил срок.
  if (!(Number(grant.ends_at) > 0)) {
    throw new ApiError(
      500,
      "Начисление не подтверждено. Проверь триггер " +
      "apply_support_grant в D1. Не отправляй новую операцию."
    );
  }

  return json({
    ok: true,
    duplicate: Number(inserted.meta?.changes || 0) === 0,
    grant
  });
}

export async function onRequest({ request, env }) {
  try {
    if (!["GET", "POST"].includes(request.method)) {
      return new Response(
        JSON.stringify({ error: "Метод не поддерживается." }),
        {
          status: 405,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "Allow": "GET, POST",
            "X-Scoffe2-Handler": "support-v1"
          }
        }
      );
    }

    // Защита команд от отправки с постороннего сайта.
    if (
      request.method === "POST" &&
      request.headers.get("Origin") !==
        new URL(request.url).origin
    ) {
      throw new ApiError(
        403,
        "Запрос разрешён только со своего сайта."
      );
    }

    if (!env.DB) {
      throw new ApiError(
        503,
        "В Cloudflare Pages не подключена база D1 с именем DB."
      );
    }

    const db = typeof env.DB.withSession === "function"
      ? env.DB.withSession("first-primary")
      : env.DB;

    const support = await authenticateSupport(db, request);

    if (request.method === "GET") {
      const result = await db.prepare(`
        SELECT g.*, u.username
        FROM support_grants g
        JOIN users u ON u.id = g.user_id
        ORDER BY g.created_at DESC, g.request_id DESC
        LIMIT 50
      `).all();

      return json({
        ok: true,
        grants: result.results || []
      });
    }

    return await givePlan(db, support, request);
  } catch (error) {
    if (error instanceof ApiError) {
      return json(
        { error: error.message },
        error.status
      );
    }

    // Не раскрываем SQL, содержимое сессий или секреты.
    return json({
      error:
        "Ошибка сервера поддержки. Проверь таблицу support_grants, " +
        "триггер apply_support_grant и привязку DB."
    }, 500);
  }
}
