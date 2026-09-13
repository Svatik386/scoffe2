const AI_BASE = "https://api.aitunnel.ru/v1";
const COOKIE = "__Host-scoffe2_session";
const SESSION_SECONDS = 14 * 24 * 60 * 60;
const PASSWORD_ITERATIONS = 100000;
const encoder = new TextEncoder();

/*
 * Цены сохранены: 59 и 99 рублей.
 *
 * Квоты ниже задаются владельцем сайта, а не браузером.
 * Каждая оплата добавляет пакет запросов и 30 дней своего тарифа.
 * Неиспользованные запросы доступны, пока действует платный тариф.
 *
 * ВАЖНО: это ограничения по количеству, не денежный бюджет.
 * Проверь себестоимость моделей, особенно видео, и установи
 * ограничение расходов в аккаунте поставщика API.
 */
const PLANS = {
  flash: {
    name: "Флэш",
    price: 5900,
    text: 50,
    image: 1,
    video: 1,
    rerank: 10
  },
  home: {
    name: "Домашний",
    price: 9900,
    text: 150,
    image: 2,
    video: 1,
    rerank: 30
  }
};

/*
 * Список моделей из исходного проекта.
 * Доступность конкретной модели зависит от AITUNNEL и аккаунта.
 * Если модель недоступна, сервер вернёт ошибку, а не фиктивный ответ.
 */
const MODELS = {
  ai: {
    flash: [
      "gpt-oss-120b",
      "mistral-nemo",
      "gpt-oss-20b",
      "mimo-v2.5"
    ],
    home: [
      "gpt-4o-mini",
      "minimax-m2",
      "gemini-3.1-flash-lite",
      "gigachat-2",
      "sonar"
    ]
  },
  image: {
    flash: [
      "gpt-image-1-mini",
      "mai-image-2.6"
    ],
    home: [
      "recraft-v4.1-pro",
      "gemini-3-pro-image",
      "gpt-image-1"
    ]
  },
  video: {
    flash: [
      "seedance-1.5-pro",
      "grok-imagine-video",
      "seedance-2.0-fast"
    ],
    home: [
      "hailuo-2.3",
      "veo-3.1-lite",
      "aleph-2"
    ]
  },
  rerank: {
    flash: ["rerank-v3.5"],
    home: ["rerank-4-pro", "qwen3-reranker-8b"]
  }
};

const QUOTA_COLUMNS = {
  ai: "text_left",
  image: "image_left",
  video: "video_left",
  rerank: "rerank_left"
};

const RESPONSE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY"
};

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function id() {
  return crypto.randomUUID().replaceAll("-", "");
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...RESPONSE_HEADERS,
      ...extraHeaders
    }
  });
}

function text(value, name, max = 8000) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max
  ) {
    throw new ApiError(400, `Некорректное поле: ${name}`);
  }

  return value.trim();
}

function username(value) {
  const result = text(value, "логин", 64)
    .normalize("NFKC")
    .toLowerCase();

  if (!/^[\p{L}\p{N}_-]{3,24}$/u.test(result)) {
    throw new ApiError(
      400,
      "Логин: 3–24 буквы, цифры, символы _ или -."
    );
  }

  return result;
}

function password(value) {
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 128
  ) {
    throw new ApiError(
      400,
      "Пароль должен содержать от 8 до 128 символов."
    );
  }

  return value;
}

function hex(bytes) {
  return Array.from(bytes, b =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

function unhex(value) {
  return new Uint8Array(
    value.match(/.{2}/g).map(part => parseInt(part, 16))
  );
}

async function sha256(value) {
  return hex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(value)
      )
    )
  );
}

async function passwordHash(value, salt) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(value),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: unhex(salt),
      iterations: PASSWORD_ITERATIONS
    },
    key,
    256
  );

  return hex(new Uint8Array(bits));
}

function equalStrings(a, b) {
  if (a.length !== b.length) return false;

  let difference = 0;

  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return difference === 0;
}

async function readText(request, maxBytes = 98304) {
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

      if (size > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, "Запрос слишком большой.");
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(result);
}

async function readJSON(request) {
  const contentType = request.headers.get("Content-Type") || "";

  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ApiError(
      415,
      "Ожидается Content-Type: application/json."
    );
  }

  const raw = await readText(request);

  try {
    const body = JSON.parse(raw);

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error();
    }

    return body;
  } catch {
    throw new ApiError(400, "Некорректный JSON.");
  }
}

async function rateLimit(db, scope, subject, limit, seconds) {
  const time = now();
  const bucket = Math.floor(time / seconds);

  const key = await sha256(
    `${scope}|${subject}|${bucket}`
  );

  const result = await db.prepare(`
    INSERT INTO rate_limits (key, count, expires_at)
    VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE
    SET count = count + 1
    WHERE count < ?
    RETURNING count
  `).bind(
    key,
    (bucket + 1) * seconds,
    limit
  ).first();

  if (!result) {
    throw new ApiError(
      429,
      "Слишком много запросов. Попробуй позже."
    );
  }
}

function cookieToken(request) {
  const raw = request.headers.get("Cookie") || "";

  for (const part of raw.split(";")) {
    const item = part.trim();

    if (item.startsWith(COOKIE + "=")) {
      const value = item.slice(COOKIE.length + 1);

      if (/^[0-9a-f]{64}$/.test(value)) {
        return value;
      }
    }
  }

  return null;
}

function sessionCookie(token, maxAge = SESSION_SECONDS) {
  return (
    `${COOKIE}=${token}; Path=/; HttpOnly; Secure; ` +
    `SameSite=Lax; Max-Age=${maxAge}`
  );
}

async function newSession(db, userId) {
  const token = hex(
    crypto.getRandomValues(new Uint8Array(32))
  );

  await db.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (?, ?, ?)
  `).bind(
    await sha256(token),
    userId,
    now() + SESSION_SECONDS
  ).run();

  return token;
}

async function currentUser(db, request) {
  const token = cookieToken(request);

  if (!token) {
    throw new ApiError(401, "Нужно войти в аккаунт.");
  }

  const user = await db.prepare(`
    SELECT
      u.id,
      u.username,
      u.flash_until,
      u.home_until,
      u.text_left,
      u.image_left,
      u.video_left,
      u.rerank_left
    FROM users u
    JOIN sessions s ON s.user_id = u.id
    WHERE s.token_hash = ?
      AND s.expires_at > ?
  `).bind(
    await sha256(token),
    now()
  ).first();

  if (!user) {
    throw new ApiError(401, "Сессия истекла. Войди снова.");
  }

  return user;
}

function tier(user) {
  const time = now();

  if (user.home_until > time) return "home";
  if (user.flash_until > time) return "flash";

  return "free";
}

function availableModels(user, kind) {
  const plan = tier(user);

  if (plan === "free") return [];

  const list = [...MODELS[kind].flash];

  if (plan === "home") {
    list.push(...MODELS[kind].home);
  }

  return [...new Set(list)];
}

function profile(user) {
  const plan = tier(user);

  return {
    id: user.id,
    username: user.username,
    plan,
    until:
      plan === "home"
        ? user.home_until
        : plan === "flash"
          ? user.flash_until
          : 0,
    quota: {
      ai: user.text_left,
      image: user.image_left,
      video: user.video_left,
      rerank: user.rerank_left
    }
  };
}

async function authenticate(db, request, body, register) {
  const login = username(body.username);
  const pass = password(body.password);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  await rateLimit(db, "auth-ip", ip, 20, 900);

  await db.batch([
    db.prepare(
      "DELETE FROM sessions WHERE expires_at <= ?"
    ).bind(now()),

    db.prepare(
      "DELETE FROM rate_limits WHERE expires_at <= ?"
    ).bind(now())
  ]);

  if (register) {
    await rateLimit(db, "register-ip", ip, 5, 3600);

    const userId = id();

    const salt = hex(
      crypto.getRandomValues(new Uint8Array(16))
    );

    const hash = await passwordHash(pass, salt);

    const results = await db.batch([
      db.prepare(`
        INSERT OR IGNORE INTO users (
          id,
          username,
          password_hash,
          password_salt,
          created_at
        )
        VALUES (?, ?, ?, ?, ?)
      `).bind(userId, login, hash, salt, now()),

      db.prepare(`
        INSERT INTO user_state (
          user_id,
          data,
          version,
          updated_at
        )
        SELECT
          id,
          '{"notes":[],"calendar":{}}',
          0,
          ?
        FROM users
        WHERE id = ?
      `).bind(now(), userId)
    ]);

    if (!results[0].meta.changes) {
      throw new ApiError(409, "Этот логин уже занят.");
    }

    const token = await newSession(db, userId);

    return json(
      { ok: true },
      201,
      { "Set-Cookie": sessionCookie(token) }
    );
  }

  await rateLimit(db, "auth-login", login, 50, 3600);

  const user = await db.prepare(`
    SELECT id, password_hash, password_salt
    FROM users
    WHERE username = ?
  `).bind(login).first();

  // Для несуществующего пользователя тоже выполняется PBKDF2.
  const salt = user
    ? user.password_salt
    : "00000000000000000000000000000000";

  const computed = await passwordHash(pass, salt);

  if (
    !user ||
    !equalStrings(computed, user.password_hash)
  ) {
    throw new ApiError(401, "Неверный логин или пароль.");
  }

  const token = await newSession(db, user.id);

  return json(
    { ok: true },
    200,
    { "Set-Cookie": sessionCookie(token) }
  );
}

function validateState(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray(value.notes) ||
    value.notes.length > 100 ||
    !value.calendar ||
    typeof value.calendar !== "object" ||
    Array.isArray(value.calendar)
  ) {
    throw new ApiError(400, "Некорректные данные блокнотов.");
  }

  const ids = new Set();

  const notes = value.notes.map(note => {
    if (
      !note ||
      typeof note.id !== "string" ||
      !/^[0-9a-f-]{16,40}$/.test(note.id) ||
      ids.has(note.id)
    ) {
      throw new ApiError(400, "Некорректный ID блокнота.");
    }

    ids.add(note.id);

    if (
      typeof note.text !== "string" ||
      note.text.length > 50000 ||
      !Array.isArray(note.checklist) ||
      note.checklist.length > 100
    ) {
      throw new ApiError(400, "Блокнот слишком большой.");
    }

    return {
      id: note.id,
      title: text(note.title, "название блокнота", 120),
      text: note.text,
      checklist: note.checklist.map(item => {
        if (
          !item ||
          typeof item.text !== "string" ||
          item.text.length > 500
        ) {
          throw new ApiError(400, "Некорректный пункт списка.");
        }

        return {
          text: item.text,
          checked: item.checked === true
        };
      })
    };
  });

  const entries = Object.entries(value.calendar);

  if (entries.length > 730) {
    throw new ApiError(400, "Слишком много календарных заметок.");
  }

  const calendar = {};

  for (const [date, value] of entries) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      typeof value !== "string" ||
      value.length > 12000
    ) {
      throw new ApiError(400, "Некорректная календарная заметка.");
    }

    calendar[date] = value;
  }

  return { notes, calendar };
}

function moneyToMinor(value) {
  if (
    typeof value !== "string" ||
    !/^\d{1,9}(?:\.\d{1,2})?$/.test(value)
  ) {
    return null;
  }

  const [whole, fraction = ""] = value.split(".");

  return (
    Number(whole) * 100 +
    Number(fraction.padEnd(2, "0"))
  );
}

function rfc3986(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    char =>
      "%" + char.charCodeAt(0).toString(16).toUpperCase()
  );
}

async function verifyNotification(params, secret) {
  const sign = params.get("sign") || "";

  if (!/^[0-9a-f]{64}$/i.test(sign)) {
    return false;
  }

  const keys = [...params.keys()].filter(key => key !== "sign");
  keys.sort();

  const canonical = keys
    .map(key => `${key}=${rfc3986(params.get(key))}`)
    .join("&");

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["verify"]
  );

  return crypto.subtle.verify(
    "HMAC",
    key,
    unhex(sign),
    encoder.encode(canonical)
  );
}

async function notification(db, env, request) {
  if (!env.YOOMONEY_NOTIFICATION_SECRET) {
    throw new ApiError(
      503,
      "Не настроен секрет уведомлений."
    );
  }

  const contentType = request.headers.get("Content-Type") || "";

  if (
    !contentType.toLowerCase()
      .includes("application/x-www-form-urlencoded")
  ) {
    throw new ApiError(415, "Неверный формат уведомления.");
  }

  const params = new URLSearchParams(
    await readText(request, 16384)
  );

  const seen = new Set();

  for (const key of params.keys()) {
    if (
      !/^[a-zA-Z0-9_]+$/.test(key) ||
      seen.has(key)
    ) {
      throw new ApiError(400, "Некорректные параметры.");
    }

    seen.add(key);
  }

  const verified = await verifyNotification(
    params,
    env.YOOMONEY_NOTIFICATION_SECRET
  );

  if (!verified) {
    throw new ApiError(403, "Неверная подпись.");
  }

  if (
    ["true", "1"].includes(params.get("test_notification"))
  ) {
    return json({ ok: true, test: true });
  }

  const label = params.get("label") || "";

  // Чужие формы этого кошелька не обрабатываем.
  if (!/^sc2_[0-9a-f]{32}$/.test(label)) {
    return json({ ok: true, ignored: true });
  }

  const order = await db.prepare(`
    SELECT *
    FROM orders
    WHERE id = ?
  `).bind(label).first();

  if (!order) {
    return json({ ok: true, ignored: true });
  }

  const operationId = params.get("operation_id") || "";

  if (
    !operationId ||
    operationId.length > 128
  ) {
    throw new ApiError(400, "Нет номера операции.");
  }

  const gross = moneyToMinor(params.get("withdraw_amount"));
  const net = moneyToMinor(params.get("amount"));
  const currency = params.get("currency") || "";

  /*
   * sum в форме: сумма списания с отправителя.
   * withdraw_amount: сумма списания с отправителя.
   * amount: сумма поступления после комиссии.
   *
   * Поэтому цену заказа сравниваем с withdraw_amount,
   * а не с amount.
   */
  const accepted =
    ["p2p-incoming", "card-incoming"].includes(
      params.get("notification_type")
    ) &&
    currency === "643" &&
    params.get("codepro") === "false" &&
    params.get("unaccepted") === "false" &&
    gross !== null &&
    gross === order.amount_minor &&
    net !== null &&
    net > 0 &&
    net <= gross;

  /*
   * INSERT и SQL-триггер образуют атомарную операцию.
   * INSERT OR IGNORE обеспечивает идемпотентность operation_id.
   */
  await db.prepare(`
    INSERT OR IGNORE INTO payments (
      operation_id,
      order_id,
      gross_minor,
      net_minor,
      currency,
      accepted,
      received_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    operationId,
    order.id,
    gross ?? -1,
    net ?? -1,
    currency,
    accepted ? 1 : 0,
    now()
  ).run();

  return json({ ok: true });
}

async function createPayment(db, env, user, body, origin) {
  const wallet = String(env.YOOMONEY_WALLET || "").trim();

  if (!/^\d{10,20}$/.test(wallet)) {
    throw new ApiError(
      503,
      "Проверь YOOMONEY_WALLET в Cloudflare."
    );
  }

  if (!env.YOOMONEY_NOTIFICATION_SECRET || !env.AITUNNEL_KEY) {
    throw new ApiError(
      503,
      "Приём оплаты пока не настроен владельцем сайта."
    );
  }

  if (!Object.hasOwn(PLANS, body.plan)) {
    throw new ApiError(400, "Неизвестный тариф.");
  }

  const paymentType = body.paymentType === "PC" ? "PC" : "AC";
  const plan = PLANS[body.plan];

  await rateLimit(db, "payment-minute", user.id, 3, 60);
  await rateLimit(db, "payment-day", user.id, 20, 86400);

  const orderId = "sc2_" + id();

  await db.prepare(`
    INSERT INTO orders (
      id,
      user_id,
      plan,
      amount_minor,
      text_quota,
      image_quota,
      video_quota,
      rerank_quota,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    orderId,
    user.id,
    body.plan,
    plan.price,
    plan.text,
    plan.image,
    plan.video,
    plan.rerank,
    now()
  ).run();

  const successURL = new URL("/", origin);
  successURL.searchParams.set("order", orderId);

  return json({
    orderId,
    action: "https://yoomoney.ru/quickpay/confirm",
    fields: {
      receiver: wallet,
      "quickpay-form": "button",
      paymentType,
      sum: (plan.price / 100).toFixed(2),
      label: orderId,
      successURL: successURL.href
    }
  });
}

async function upstream(env, path, payload, extraHeaders = {}) {
  if (!env.AITUNNEL_KEY) {
    throw new ApiError(503, "Не настроен AITUNNEL_KEY.");
  }

  let response;

  try {
    response = await fetch(AI_BASE + path, {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${env.AITUNNEL_KEY}`,
        ...(payload === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...extraHeaders
      },
      body:
        payload === undefined
          ? undefined
          : JSON.stringify(payload),
      redirect: "manual",
      signal: AbortSignal.timeout(180000)
    });
  } catch {
    throw new ApiError(
      504,
      "Нет ответа AITUNNEL. Не повторяй генерацию автоматически: " +
      "провайдер мог уже принять запрос."
    );
  }

  if (!response.ok) {
    const status = response.status;

    if (response.body) {
      await response.body.cancel();
    }

    let message = `AITUNNEL вернул ошибку ${status}.`;

    if (status === 401 || status === 403) {
      message = "AITUNNEL отклонил ключ или доступ к модели.";
    } else if (status === 402) {
      message = "Недостаточно средств на стороне AITUNNEL.";
    } else if (status === 429) {
      message = "AITUNNEL ограничил частоту запросов.";
    } else if (status === 400 || status === 404) {
      message = "Модель или параметры недоступны в AITUNNEL.";
    }

    throw new ApiError(status === 429 ? 429 : 502, message);
  }

  return response;
}

async function upstreamJSON(env, path, payload) {
  const response = await upstream(env, path, payload);

  try {
    return await response.json();
  } catch {
    throw new ApiError(502, "AITUNNEL вернул некорректный ответ.");
  }
}

async function reserveGeneration(db, user, kind, model) {
  const column = QUOTA_COLUMNS[kind];

  if (!column) {
    throw new ApiError(400, "Неизвестный тип генерации.");
  }

  const generationId = id();
  const time = now();

  /*
   * Название колонки выбирается только из серверного словаря.
   * Вставка задания и списание квоты выполняются одной транзакцией.
   */
  const results = await db.batch([
    db.prepare(`
      INSERT INTO generations (
        id,
        user_id,
        kind,
        model,
        status,
        created_at
      )
      SELECT ?, id, ?, ?, 'reserved', ?
      FROM users
      WHERE id = ?
        AND ${column} > 0
        AND (flash_until > ? OR home_until > ?)
    `).bind(
      generationId,
      kind,
      model,
      time,
      user.id,
      time,
      time
    ),

    db.prepare(`
      UPDATE users
      SET ${column} = ${column} - 1
      WHERE id = ?
        AND ${column} > 0
        AND EXISTS (
          SELECT 1
          FROM generations
          WHERE id = ? AND user_id = ?
        )
    `).bind(user.id, generationId, user.id)
  ]);

  if (!results[0].meta.changes) {
    throw new ApiError(
      403,
      "Тариф истёк или закончились запросы этого типа."
    );
  }

  return generationId;
}

function normalizeVideoStatus(value) {
  if (value === "completed") return "completed";

  if (["failed", "expired", "cancelled"].includes(value)) {
    return "failed";
  }

  return "pending";
}

function safeProviderId(value) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9_-]{1,180}$/.test(value)
  ) {
    throw new ApiError(502, "AITUNNEL вернул неверный ID видео.");
  }

  return value;
}

async function ownedVideo(db, user, generationId) {
  if (!/^[0-9a-f]{32}$/.test(generationId)) {
    throw new ApiError(400, "Некорректный ID видео.");
  }

  const job = await db.prepare(`
    SELECT *
    FROM generations
    WHERE id = ?
      AND user_id = ?
      AND kind = 'video'
  `).bind(generationId, user.id).first();

  if (!job) {
    throw new ApiError(404, "Видео не найдено.");
  }

  return job;
}

async function videoStatus(db, env, user, generationId) {
  const job = await ownedVideo(db, user, generationId);

  if (!job.provider_id) {
    return json({
      id: job.id,
      status:
        job.status === "reserved"
          ? "pending"
          : job.status
    });
  }

  let status = job.status;

  if (!["completed", "failed"].includes(status)) {
    await rateLimit(db, "video-poll", user.id, 30, 60);

    const data = await upstreamJSON(
      env,
      "/videos/" + safeProviderId(job.provider_id)
    );

    status = normalizeVideoStatus(data.status);

    await db.prepare(`
      UPDATE generations
      SET status = ?
      WHERE id = ? AND user_id = ?
    `).bind(status, job.id, user.id).run();
  }

  return json({
    id: job.id,
    status,
    url:
      status === "completed"
        ? "/api/video-content/" + job.id
        : null
  });
}

async function videoContent(db, env, user, request, generationId) {
  const job = await ownedVideo(db, user, generationId);

  if (job.status !== "completed" || !job.provider_id) {
    throw new ApiError(409, "Видео ещё не готово.");
  }

  const range = request.headers.get("Range");

  if (range && !/^bytes=\d*-\d*$/.test(range)) {
    throw new ApiError(400, "Некорректный диапазон.");
  }

  const response = await upstream(
    env,
    "/videos/" + safeProviderId(job.provider_id) + "/content",
    undefined,
    range ? { Range: range } : {}
  );

  const headers = new Headers({
    "Content-Type": "video/mp4",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });

  for (const name of [
    "Content-Length",
    "Content-Range",
    "Accept-Ranges"
  ]) {
    if (response.headers.has(name)) {
      headers.set(name, response.headers.get(name));
    }
  }

  return new Response(response.body, {
    status: response.status,
    headers
  });
}

async function generate(db, env, user, kind, body) {
  if (!env.AITUNNEL_KEY) {
    throw new ApiError(503, "Не настроен AITUNNEL_KEY.");
  }

  if (!availableModels(user, kind).includes(body.model)) {
    throw new ApiError(
      403,
      "Эта модель недоступна на твоём тарифе."
    );
  }

  let path;
  let payload;
  let documents = [];

  // Все параметры проверяются ДО списания квоты.
  if (kind === "ai") {
    if (
      !Array.isArray(body.messages) ||
      !body.messages.length ||
      body.messages.length > 20
    ) {
      throw new ApiError(400, "Нужно от 1 до 20 сообщений.");
    }

    const messages = body.messages.map(message => {
      if (
        !message ||
        !["user", "assistant"].includes(message.role)
      ) {
        throw new ApiError(400, "Некорректное сообщение.");
      }

      return {
        role: message.role,
        content: text(message.content, "сообщение", 8000)
      };
    });

    const total = messages.reduce(
      (sum, message) => sum + message.content.length,
      0
    );

    if (total > 30000) {
      throw new ApiError(
        400,
        "История слишком большая. Очисти чат."
      );
    }

    path = "/chat/completions";
    payload = {
      model: body.model,
      messages,
      max_tokens: 1000,
      temperature: 0.7,
      stream: false
    };
  } else if (kind === "image") {
    path = "/images/generations";
    payload = {
      model: body.model,
      prompt: text(body.prompt, "описание", 4000),
      n: 1
    };
  } else if (kind === "video") {
    path = "/videos";
    payload = {
      model: body.model,
      prompt: text(body.prompt, "описание", 4000)
    };
  } else {
    const query = text(body.query, "запрос", 2000);

    if (
      !Array.isArray(body.documents) ||
      !body.documents.length ||
      body.documents.length > 40
    ) {
      throw new ApiError(
        400,
        "Нужно от 1 до 40 фрагментов текста."
      );
    }

    documents = body.documents.map(item =>
      text(item, "фрагмент", 2000)
    );

    path = "/rerank";
    payload = {
      model: body.model,
      query,
      documents
    };
  }

  await rateLimit(db, "ai-minute", user.id, 15, 60);

  const generationId = await reserveGeneration(
    db,
    user,
    kind,
    body.model
  );

  try {
    const data = await upstreamJSON(env, path, payload);
    let result;

    if (kind === "ai") {
      const content = data.choices?.[0]?.message?.content;

      if (typeof content !== "string" || !content) {
        throw new ApiError(502, "Модель не вернула текст.");
      }

      result = { content };
    } else if (kind === "image") {
      const image = data.data?.[0];

      if (typeof image?.b64_json === "string") {
        const mime = [
          "image/png",
          "image/jpeg",
          "image/webp"
        ].includes(image.media_type)
          ? image.media_type
          : "image/png";

        result = {
          image_url: `data:${mime};base64,${image.b64_json}`
        };
      } else if (typeof image?.url === "string") {
        let imageURL;

        try {
          imageURL = new URL(image.url);
        } catch {
          throw new ApiError(502, "Неверный адрес изображения.");
        }

        const exposesKey =
          image.url.includes(env.AITUNNEL_KEY) ||
          [...imageURL.searchParams.values()]
            .some(value => value.includes(env.AITUNNEL_KEY));

        if (
          imageURL.protocol !== "https:" ||
          imageURL.username ||
          imageURL.password ||
          exposesKey
        ) {
          throw new ApiError(502, "Небезопасный адрес изображения.");
        }

        result = { image_url: imageURL.href };
      } else {
        throw new ApiError(502, "Модель не вернула изображение.");
      }
    } else if (kind === "video") {
      const providerId = safeProviderId(data.id);
      const status = normalizeVideoStatus(data.status);

      await db.prepare(`
        UPDATE generations
        SET provider_id = ?, status = ?
        WHERE id = ? AND user_id = ?
      `).bind(
        providerId,
        status,
        generationId,
        user.id
      ).run();

      return json({
        id: generationId,
        status,
        url:
          status === "completed"
            ? "/api/video-content/" + generationId
            : null
      }, 202);
    } else {
      if (!Array.isArray(data.results)) {
        throw new ApiError(502, "Модель не вернула ранжирование.");
      }

      result = {
        results: data.results
          .filter(item =>
            Number.isInteger(item.index) &&
            item.index >= 0 &&
            item.index < documents.length
          )
          .map(item => ({
            index: item.index,
            text: documents[item.index],
            relevance_score:
              Number.isFinite(item.relevance_score)
                ? item.relevance_score
                : null
          }))
      };
    }

    await db.prepare(`
      UPDATE generations
      SET status = 'completed'
      WHERE id = ? AND user_id = ?
    `).bind(generationId, user.id).run();

    return json(result);
  } catch (error) {
    /*
     * Автовозврат квоты не выполняется:
     * даже при тайм-ауте провайдер мог принять платный запрос.
     * Задание остаётся в базе для разбирательства владельцем.
     */
    try {
      await db.prepare(`
        UPDATE generations
        SET status = ?
        WHERE id = ? AND user_id = ?
      `).bind(
        error?.status === 504 ? "unknown" : "failed",
        generationId,
        user.id
      ).run();
    } catch {
      // Не подменяем исходную ошибку ошибкой записи журнала.
    }

    const message =
      error instanceof ApiError
        ? error.message
        : "Ошибка обработки ответа модели.";

    throw new ApiError(
      error instanceof ApiError ? error.status : 502,
      `${message} Запрос учтён в квоте. ID: ${generationId}`
    );
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const route = url.pathname
    .replace(/^\/api\/?/, "")
    .replace(/\/$/, "");

  try {
    if (!env.DB) {
      throw new ApiError(
        503,
        "В Cloudflare Pages не подключена база D1 с именем DB."
      );
    }

    // При наличии read replication первый запрос идёт на primary.
    const db = typeof env.DB.withSession === "function"
      ? env.DB.withSession("first-primary")
      : env.DB;

    if (
      route === "yoomoney/notify" &&
      request.method === "POST"
    ) {
      return await notification(db, env, request);
    }

    if (!["GET", "POST"].includes(request.method)) {
      throw new ApiError(405, "Метод не поддерживается.");
    }

    // Защита браузерных изменений от CSRF.
    // Для вебхука выше используется криптографическая подпись.
    if (
      request.method === "POST" &&
      request.headers.get("Origin") !== url.origin
    ) {
      throw new ApiError(403, "Запрос с другого сайта запрещён.");
    }

    if (route === "health" && request.method === "GET") {
      await db.prepare("SELECT 1 AS ok").first();

      return json({
        ok: true,
        database: true,
        aiConfigured: Boolean(env.AITUNNEL_KEY),
        paymentsConfigured: Boolean(
          env.YOOMONEY_WALLET &&
          env.YOOMONEY_NOTIFICATION_SECRET
        )
      });
    }

    if (
      ["auth/register", "auth/login"].includes(route) &&
      request.method === "POST"
    ) {
      return await authenticate(
        db,
        request,
        await readJSON(request),
        route === "auth/register"
      );
    }

    if (
      route === "auth/logout" &&
      request.method === "POST"
    ) {
      const token = cookieToken(request);

      if (token) {
        await db.prepare(`
          DELETE FROM sessions WHERE token_hash = ?
        `).bind(await sha256(token)).run();
      }

      return json(
        { ok: true },
        200,
        { "Set-Cookie": sessionCookie("", 0) }
      );
    }

    const user = await currentUser(db, request);

    if (route === "me" && request.method === "GET") {
      return json({
        user: profile(user),
        plans: PLANS,
        models: Object.fromEntries(
          Object.keys(MODELS).map(kind => [
            kind,
            availableModels(user, kind)
          ])
        )
      });
    }

    if (route === "state" && request.method === "GET") {
      const row = await db.prepare(`
        SELECT data, version
        FROM user_state
        WHERE user_id = ?
      `).bind(user.id).first();

      return json({
        data: row
          ? JSON.parse(row.data)
          : { notes: [], calendar: {} },
        version: row?.version ?? 0
      });
    }

    if (route === "state" && request.method === "POST") {
      const body = await readJSON(request);

      if (
        !Number.isInteger(body.version) ||
        body.version < 0
      ) {
        throw new ApiError(400, "Неверная версия данных.");
      }

      const state = validateState(body.data);
      const serialized = JSON.stringify(state);

      if (encoder.encode(serialized).byteLength > 90000) {
        throw new ApiError(
          413,
          "Данные превышают 90 КБ. Скачай и удали старые записи."
        );
      }

      const result = await db.prepare(`
        UPDATE user_state
        SET data = ?,
            version = version + 1,
            updated_at = ?
        WHERE user_id = ?
          AND version = ?
      `).bind(
        serialized,
        now(),
        user.id,
        body.version
      ).run();

      if (!result.meta.changes) {
        throw new ApiError(
          409,
          "Данные изменены в другой вкладке. " +
          "Скопируй несохранённый текст и обнови страницу."
        );
      }

      return json({
        ok: true,
        version: body.version + 1
      });
    }

    if (route === "pay" && request.method === "POST") {
      return await createPayment(
        db,
        env,
        user,
        await readJSON(request),
        url.origin
      );
    }

    if (route === "orders" && request.method === "GET") {
      const result = await db.prepare(`
        SELECT
          id,
          plan,
          amount_minor,
          status,
          created_at,
          paid_at
        FROM orders
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 30
      `).bind(user.id).all();

      return json({ orders: result.results });
    }

    if (route === "messages" && request.method === "GET") {
      const result = await db.prepare(`
        SELECT
          m.id,
          m.sender_id,
          m.recipient_id,
          m.text,
          m.created_at,
          sender.username AS sender_name,
          recipient.username AS recipient_name
        FROM messages m
        JOIN users sender ON sender.id = m.sender_id
        JOIN users recipient ON recipient.id = m.recipient_id
        WHERE m.sender_id = ? OR m.recipient_id = ?
        ORDER BY m.created_at DESC
        LIMIT 50
      `).bind(user.id, user.id).all();

      return json({ messages: result.results });
    }

    if (route === "messages" && request.method === "POST") {
      const body = await readJSON(request);
      const recipient = text(body.recipient, "получатель", 64)
        .normalize("NFKC")
        .toLowerCase();

      const message = text(body.text, "сообщение", 4000);

      await rateLimit(db, "message-minute", user.id, 5, 60);
      await rateLimit(db, "message-day", user.id, 100, 86400);

      const target = await db.prepare(`
        SELECT id
        FROM users
        WHERE id = ? OR username = ?
      `).bind(recipient, recipient).first();

      if (!target) {
        throw new ApiError(404, "Получатель не найден.");
      }

      await db.prepare(`
        INSERT INTO messages (
          id,
          sender_id,
          recipient_id,
          text,
          created_at
        )
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        id(),
        user.id,
        target.id,
        message,
        now()
      ).run();

      return json({ ok: true }, 201);
    }

    if (route === "jobs" && request.method === "GET") {
      const result = await db.prepare(`
        SELECT id, model, status, created_at
        FROM generations
        WHERE user_id = ? AND kind = 'video'
        ORDER BY created_at DESC
        LIMIT 20
      `).bind(user.id).all();

      return json({ jobs: result.results });
    }

    if (
      route.startsWith("video-status/") &&
      request.method === "GET"
    ) {
      return await videoStatus(
        db,
        env,
        user,
        route.slice("video-status/".length)
      );
    }

    if (
      route.startsWith("video-content/") &&
      request.method === "GET"
    ) {
      return await videoContent(
        db,
        env,
        user,
        request,
        route.slice("video-content/".length)
      );
    }

    if (
      Object.hasOwn(QUOTA_COLUMNS, route) &&
      request.method === "POST"
    ) {
      return await generate(
        db,
        env,
        user,
        route,
        await readJSON(request)
      );
    }

    throw new ApiError(404, "API-маршрут не найден.");
  } catch (error) {
    if (error instanceof ApiError) {
      return json(
        { error: error.message },
        error.status
      );
    }

    // Не отдаём клиенту исключения, SQL, заголовки или секреты.
    return json({
      error:
        "Ошибка сервера. Проверь, выполнен ли schema.sql, " +
        "подключена ли DB и добавлены ли секреты."
    }, 500);
  }
}
