const SUPPORT_ID = "1019a3fd516d4ce1b67df99e3133c46a";
const MODELS_URL = "https://api.aitunnel.ru/v1/models";

function reply(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Scoffe2-Handler": "ai-check-v1"
    }
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET") {
    return reply({
      error: "Разрешена только проверка GET."
    }, 405);
  }

  try {
    if (!env.DB) {
      return reply({
        error: "Не подключена база DB."
      }, 503);
    }

    // Проверка действующей серверной сессии.
    const cookie = request.headers.get("Cookie") || "";

    const match = cookie.match(
      /(?:^|;\s*)__Host-scoffe2_session=([0-9a-f]{64})(?:;|$)/
    );

    if (!match) {
      return reply({
        error: "Сначала войди в аккаунт поддержки."
      }, 401);
    }

    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(match[1])
    );

    const hash = Array.from(
      new Uint8Array(digest),
      byte => byte.toString(16).padStart(2, "0")
    ).join("");

    const db = typeof env.DB.withSession === "function"
      ? env.DB.withSession("first-primary")
      : env.DB;

    const user = await db.prepare(`
      SELECT u.id
      FROM users u
      JOIN sessions s ON s.user_id = u.id
      WHERE s.token_hash = ?
        AND s.expires_at > ?
    `).bind(
      hash,
      Math.floor(Date.now() / 1000)
    ).first();

    if (!user) {
      return reply({
        error: "Сессия истекла. Войди снова."
      }, 401);
    }

    if (user.id !== SUPPORT_ID) {
      return reply({
        error: "Проверка доступна только поддержке."
      }, 403);
    }

    // Только последние текстовые запросы этого аккаунта.
    // Тексты промптов не читаются.
    const history = await db.prepare(`
      SELECT id, model, status, created_at
      FROM generations
      WHERE user_id = ?
        AND kind = 'ai'
      ORDER BY created_at DESC, id DESC
      LIMIT 5
    `).bind(user.id).all();

    const report = {
      checkedAt: new Date().toISOString(),
      lastTextRequests: history.results || [],
      note:
        "Статусы взяты из базы сайта, а не из биллинга AITUNNEL."
    };

    const key = env.AITUNNEL_KEY;

    if (typeof key !== "string" || !key.trim()) {
      return reply({
        ...report,
        result: "Не задан AITUNNEL_KEY."
      });
    }

    if (/\s/.test(key)) {
      return reply({
        ...report,
        result:
          "В AITUNNEL_KEY есть пробелы или переносы строк. " +
          "В секрете должен быть только сам ключ, без Bearer."
      });
    }

    const started = Date.now();
    let phase = "connection";

    try {
      // Запрашиваем только каталог.
      // Генерация и списание квот сайта здесь не выполняются.
      const response = await fetch(MODELS_URL, {
        method: "GET",
        headers: {
          "Authorization": "Bearer " + key,
          "Accept": "application/json"
        },
        redirect: "manual",
        signal: AbortSignal.timeout(15000)
      });

      report.providerStatus = response.status;

      if (!response.ok) {
        // Не возвращаем содержимое ошибки провайдера:
        // оно может содержать служебные данные.
        if (response.body) {
          await response.body.cancel().catch(() => {});
        }

        report.elapsedMs = Date.now() - started;

        const messages = {
          401:
            "AITUNNEL отклонил авторизацию. Проверь ключ.",
          402:
            "AITUNNEL сообщил об ограничении оплаты или баланса.",
          403:
            "AITUNNEL запретил доступ. Возможны ограничения ключа или IP.",
          429:
            "AITUNNEL ограничил частоту запросов."
        };

        report.result =
          messages[response.status] ||
          "Каталог AITUNNEL вернул HTTP " +
          response.status + ".";

        return reply(report);
      }

      phase = "response";

      const data = await response.json();
      report.elapsedMs = Date.now() - started;

      if (!Array.isArray(data.data)) {
        report.result =
          "AITUNNEL вернул неожиданный формат каталога.";

        return reply(report);
      }

      const modelIds = new Set(
        data.data
          .map(item => item?.id)
          .filter(id => typeof id === "string")
      );

      const lastModel = report.lastTextRequests[0]?.model;

      if (lastModel) {
        report.lastModel = lastModel;
        report.lastModelInCatalog = modelIds.has(lastModel);
      }

      report.result =
        "Cloudflare получил каталог моделей AITUNNEL с этим ключом. " +
        "Генерация не запускалась. Работу chat/completions это не проверяет.";

      return reply(report);
    } catch (error) {
      report.elapsedMs = Date.now() - started;

      const timeout = [
        "TimeoutError",
        "AbortError"
      ].includes(error?.name);

      if (timeout) {
        report.result =
          "Проверка AITUNNEL не завершилась за 15 секунд. " +
          "Это таймаут диагностики.";
      } else if (
        phase === "response" &&
        error?.name === "SyntaxError"
      ) {
        report.result =
          "AITUNNEL вернул ответ, который не удалось прочитать как JSON.";
      } else {
        report.result =
          "Cloudflare не смог завершить сетевой запрос к AITUNNEL.";
      }

      return reply(report);
    }
  } catch {
    return reply({
      error:
        "Не удалось прочитать сессию или журнал. " +
        "Проверь DB и таблицы generations, users, sessions."
    }, 500);
  }
}
