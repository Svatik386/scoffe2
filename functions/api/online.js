const SUPPORT_ID = "1019a3fd516d4ce1b67df99e3133c46a";
const VISITOR_COOKIE = "__Host-scoffe2_online";
const ONLINE_SECONDS = 90;

function reply(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "Vary": "Cookie",
      "X-Scoffe2-Handler": "online-v1",
      ...extraHeaders
    }
  });
}

function readCookie(request, name, length) {
  const part = (request.headers.get("Cookie") || "")
    .split(";")
    .map(value => value.trim())
    .find(value => value.startsWith(name + "="));

  const value = part
    ? part.slice(name.length + 1)
    : "";

  return new RegExp(
    "^[0-9a-f]{" + length + "}$"
  ).test(value)
    ? value
    : null;
}

function visitorCookie(id) {
  return (
    VISITOR_COOKIE + "=" + id +
    "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=86400"
  );
}

async function sha256(value) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );

  return Array.from(
    new Uint8Array(hash),
    byte => byte.toString(16).padStart(2, "0")
  ).join("");
}

export async function onRequest({ request, env }) {
  const method = request.method;

  if (!["GET", "POST"].includes(method)) {
    return reply(
      { error: "Метод не поддерживается." },
      405,
      { Allow: "GET, POST" }
    );
  }

  // Записывать посещения разрешено только со своего сайта.
  if (
    method === "POST" &&
    request.headers.get("Origin") !==
      new URL(request.url).origin
  ) {
    return reply(
      { error: "Запрос с другого сайта запрещён." },
      403
    );
  }

  if (!env.DB) {
    return reply(
      {
        error:
          "В Pages не подключена база D1 с именем DB."
      },
      503
    );
  }

  try {
    const db =
      typeof env.DB.withSession === "function"
        ? env.DB.withSession("first-primary")
        : env.DB;

    const now = Math.floor(Date.now() / 1000);

    // GET: получить число. Только для аккаунта поддержки.
    if (method === "GET") {
      const token = readCookie(
        request,
        "__Host-scoffe2_session",
        64
      );

      if (!token) {
        return reply(
          { error: "Нужно войти в аккаунт." },
          401
        );
      }

      const user = await db.prepare(`
        SELECT u.id
        FROM users u
        JOIN sessions s ON s.user_id = u.id
        WHERE s.token_hash = ?
          AND s.expires_at > ?
        LIMIT 1
      `)
        .bind(await sha256(token), now)
        .first();

      if (!user) {
        return reply(
          { error: "Сессия истекла. Войди заново." },
          401
        );
      }

      if (user.id !== SUPPORT_ID) {
        return reply(
          { error: "Только для аккаунта поддержки." },
          403
        );
      }

      const row = await db.prepare(`
        SELECT COUNT(*) AS online
        FROM online_visitors
        WHERE last_seen > ?
      `)
        .bind(now - ONLINE_SECONDS)
        .first();

      return reply({
        ok: true,
        online: Number(row.online),
        windowSeconds: ONLINE_SECONDS,
        checkedAt: now
      });
    }

    // POST: отметить активный браузер.
    // Вход в аккаунт не требуется: гости тоже учитываются.
    const visitorId = readCookie(
      request,
      VISITOR_COOKIE,
      32
    );

    if (!visitorId) {
      const id = crypto.randomUUID().replaceAll("-", "");

      // Сначала устанавливаем cookie.
      // Следующий запрос подтвердит, что браузер её сохранил.
      return reply(
        {
          ok: true,
          needsHeartbeat: true
        },
        200,
        {
          "Set-Cookie": visitorCookie(id)
        }
      );
    }

    // Базовое ограничение: 600 сигналов в минуту с одного IP.
    // Сам IP в таблицу не записывается.
    const rateKey =
      "online:" +
      await sha256(
        request.headers.get("CF-Connecting-IP") || "unknown"
      );

    const allowed = await db.prepare(`
      INSERT INTO rate_limits (key, count, expires_at)
      VALUES (?, 1, ?)

      ON CONFLICT(key) DO UPDATE SET
        count = CASE
          WHEN rate_limits.expires_at <= ?
          THEN 1
          ELSE rate_limits.count + 1
        END,

        expires_at = CASE
          WHEN rate_limits.expires_at <= ?
          THEN excluded.expires_at
          ELSE rate_limits.expires_at
        END

      WHERE rate_limits.expires_at <= ?
         OR rate_limits.count < 600

      RETURNING count
    `)
      .bind(rateKey, now + 60, now, now, now)
      .first();

    if (!allowed) {
      return reply(
        {
          error:
            "Слишком много запросов. Подожди минуту."
        },
        429,
        {
          "Retry-After": "60"
        }
      );
    }

    await db.batch([
      // Вкладки с одной cookie обновляют одну запись.
      db.prepare(`
        INSERT INTO online_visitors (visitor_id, last_seen)
        VALUES (?, ?)

        ON CONFLICT(visitor_id) DO UPDATE SET
          last_seen = excluded.last_seen

        WHERE online_visitors.last_seen
              < excluded.last_seen - 15
      `).bind(visitorId, now),

      // Удаляем старые отметки небольшими порциями.
      db.prepare(`
        DELETE FROM online_visitors
        WHERE visitor_id IN (
          SELECT visitor_id
          FROM online_visitors
          WHERE last_seen < ?
          LIMIT 200
        )
      `).bind(now - 600),

      // Чистим только старые ограничения этого счётчика.
      db.prepare(`
        DELETE FROM rate_limits
        WHERE key IN (
          SELECT key
          FROM rate_limits
          WHERE key LIKE 'online:%'
            AND expires_at < ?
          LIMIT 200
        )
      `).bind(now - 600)
    ]);

    return reply(
      { ok: true },
      200,
      {
        "Set-Cookie": visitorCookie(visitorId)
      }
    );
  } catch (error) {
    console.error("online-v1:", error.message);

    return reply(
      {
        error:
          "Ошибка счётчика. Проверь таблицы " +
          "online_visitors, rate_limits и привязку DB."
      },
      500
    );
  }
}
