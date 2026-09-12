const SUPPORT_CONTACT_ID = "1019a3fd516d4ce1b67df99e3133c46a";

let supportCommandBusy = false;
let supportAttempt = null;

function updateSupportAccess() {
  const allowed = account?.isSupport === true;
  const button = $("support-panel-button");

  if (button) {
    button.style.display = allowed ? "flex" : "none";
  }

  if (!allowed && $("modal-support")) {
    closeModal("modal-support");
  }
}

function contactSupport() {
  // Используем существующую систему личных сообщений.
  $("msg-recipient").value = SUPPORT_CONTACT_ID;
  openModal("modal-message");
  $("msg-text").focus();
}

function openSupportPanel() {
  return run(async () => {
    await refreshAccount();

    if (account?.isSupport !== true) {
      throw new Error(
        "Панель доступна только аккаунту поддержки."
      );
    }

    openModal("modal-support");
    $("support-command").focus();

    await loadSupportHistory();
  });
}

function openSupportMessages() {
  closeModal("modal-support");
  return switchView("messages");
}

async function loadSupportHistory() {
  const data = await api("support");
  const container = $("support-history");

  container.replaceChildren();

  if (!data.grants.length) {
    container.append(
      el("p", "Выдач пока нет.", "small-muted")
    );
    return;
  }

  for (const grant of data.grants) {
    const row = el("div", null, "section-panel");

    const planName =
      serverPlans[grant.plan]?.name || grant.plan;

    row.append(
      el(
        "strong",
        grant.username + ": " + planName
      ),

      el(
        "p",
        "ID пользователя: " + grant.user_id
      ),

      el(
        "p",
        "Добавлено месяцев: " + grant.months +
        ". Срок выбранного тарифа после выдачи: " +
        formatTimestamp(grant.ends_at)
      ),

      el(
        "p",
        "Добавленные квоты: текст " + grant.text_quota +
        ", изображения " + grant.image_quota +
        ", видео " + grant.video_quota +
        ", ранжирование " + grant.rerank_quota
      ),

      el(
        "p",
        "Выдано: " + formatTimestamp(grant.created_at),
        "small-muted"
      ),

      el(
        "p",
        "Операция: " + grant.request_id,
        "small-muted"
      )
    );

    container.append(row);
  }
}

async function submitSupportCommand() {
  if (supportCommandBusy) return;

  const input = $("support-command");
  const button = $("support-command-button");
  const output = $("support-command-result");

  if (account?.isSupport !== true) {
    output.textContent = "Нет доступа к панели поддержки.";
    return;
  }

  const command = input.value.trim();

  if (!command) {
    output.textContent = "Введи команду.";
    return;
  }

  // После неоднозначного сетевого сбоя повторяем
  // только ту же операцию с тем же requestId.
  if (
    supportAttempt &&
    supportAttempt.command !== command
  ) {
    input.value = supportAttempt.command;
    input.readOnly = true;

    output.textContent =
      "Сначала уточни результат предыдущей операции. " +
      "Нажми «Выполнить» ещё раз: будет отправлен тот же " +
      "ID операции, без повторного начисления.";

    return;
  }

  if (!supportAttempt) {
    const accepted = window.confirm(
      "Выполнить бесплатную выдачу тарифа?\n\n" +
      command +
      "\n\nТариф будет продлён, квоты будут добавлены."
    );

    if (!accepted) return;

    supportAttempt = {
      requestId: crypto.randomUUID().replaceAll("-", ""),
      command
    };
  }

  const attempt = { ...supportAttempt };

  supportCommandBusy = true;
  button.disabled = true;
  input.readOnly = true;

  output.textContent =
    "Выполняется операция " + attempt.requestId + "…";

  try {
    const result = await api("support", attempt);
    const grant = result.grant;

    // Убираем идентификатор только после подтверждения.
    supportAttempt = null;
    input.value = "";

    const planName =
      serverPlans[grant.plan]?.name || grant.plan;

    output.textContent =
      (
        result.duplicate
          ? "Эта операция уже выполнена. Повторного начисления нет."
          : "Тариф выдан."
      ) +
      "\nПользователь: " + grant.user_id +
      "\nТариф: " + planName +
      "\nДобавлено месяцев: " + grant.months +
      "\nСрок выбранного тарифа после выдачи: " +
      formatTimestamp(grant.ends_at) +
      "\nДобавлено текстовых запросов: " + grant.text_quota +
      "\nИзображений: " + grant.image_quota +
      "\nВидео: " + grant.video_quota +
      "\nРанжирований: " + grant.rerank_quota +
      "\nID операции: " + grant.request_id;

    // Ошибка обновления интерфейса не должна превращать
    // подтверждённую выдачу в «неизвестный результат».
    if (grant.user_id === account.id) {
      await refreshAccount().catch(() => {
        showToast(
          "Тариф выдан. Для обновления счётчиков нажми «Обновить тариф».",
          "info"
        );
      });
    }

    await loadSupportHistory().catch(() => {
      showToast(
        "Тариф выдан, но журнал не обновился. Нажми «Обновить журнал».",
        "info"
      );
    });
  } catch (error) {
    const message = error.status
      ? error.message
      : "Не удалось получить подтверждение от сервера.";

    // Эти ответы позволяют исправить саму команду.
    if ([400, 404, 409].includes(error.status)) {
      supportAttempt = null;
      output.textContent = message;
    } else {
      output.textContent =
        message +
        "\nID операции: " + attempt.requestId +
        "\nНажми «Выполнить» для повтора той же операции. " +
        "Повторное начисление с этим ID исключено." +
        "\nЕсли перезагрузишь страницу, сначала проверь журнал.";
    }
  } finally {
    supportCommandBusy = false;
    button.disabled = false;
    input.readOnly = supportAttempt !== null;
  }
}
