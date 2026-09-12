PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  flash_until INTEGER NOT NULL DEFAULT 0,
  home_until INTEGER NOT NULL DEFAULT 0,
  text_left INTEGER NOT NULL DEFAULT 0 CHECK (text_left >= 0),
  image_left INTEGER NOT NULL DEFAULT 0 CHECK (image_left >= 0),
  video_left INTEGER NOT NULL DEFAULT 0 CHECK (video_left >= 0),
  rerank_left INTEGER NOT NULL DEFAULT 0 CHECK (rerank_left >= 0)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user
ON sessions(user_id);

CREATE INDEX IF NOT EXISTS sessions_expiry
ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS user_state (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL DEFAULT '{"notes":[],"calendar":{}}',
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS rate_limits_expiry
ON rate_limits(expires_at);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL CHECK (plan IN ('flash', 'home')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  text_quota INTEGER NOT NULL,
  image_quota INTEGER NOT NULL,
  video_quota INTEGER NOT NULL,
  rerank_quota INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'review')),
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);

CREATE INDEX IF NOT EXISTS orders_user_created
ON orders(user_id, created_at);

CREATE TABLE IF NOT EXISTS payments (
  operation_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  gross_minor INTEGER NOT NULL,
  net_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS payments_order
ON payments(order_id);

-- Обработка подтверждённого платежа и выдача тарифа происходят
-- атомарно, внутри одной операции вставки платежа.
--
-- Повторное уведомление с тем же operation_id не создаёт новую запись.
-- Другой платёж за уже оплаченный заказ не продлевает тариф повторно.

CREATE TRIGGER IF NOT EXISTS grant_paid_order
AFTER INSERT ON payments
WHEN
  NEW.accepted = 1
  AND NEW.currency = '643'
  AND NEW.net_minor > 0
  AND NEW.net_minor <= NEW.gross_minor
  AND EXISTS (
    SELECT 1
    FROM orders
    WHERE id = NEW.order_id
      AND status IN ('pending', 'review')
      AND amount_minor = NEW.gross_minor
  )
BEGIN
  UPDATE users
  SET
    flash_until = CASE
      WHEN (
        SELECT plan FROM orders WHERE id = NEW.order_id
      ) = 'flash'
      THEN MAX(flash_until, unixepoch()) + 2592000
      ELSE flash_until
    END,

    home_until = CASE
      WHEN (
        SELECT plan FROM orders WHERE id = NEW.order_id
      ) = 'home'
      THEN MAX(home_until, unixepoch()) + 2592000
      ELSE home_until
    END,

    text_left = text_left + (
      SELECT text_quota FROM orders WHERE id = NEW.order_id
    ),

    image_left = image_left + (
      SELECT image_quota FROM orders WHERE id = NEW.order_id
    ),

    video_left = video_left + (
      SELECT video_quota FROM orders WHERE id = NEW.order_id
    ),

    rerank_left = rerank_left + (
      SELECT rerank_quota FROM orders WHERE id = NEW.order_id
    )

  WHERE id = (
    SELECT user_id FROM orders WHERE id = NEW.order_id
  );

  UPDATE orders
  SET status = 'paid',
      paid_at = unixepoch()
  WHERE id = NEW.order_id;
END;

CREATE TRIGGER IF NOT EXISTS mark_payment_for_review
AFTER INSERT ON payments
WHEN NEW.accepted = 0
BEGIN
  UPDATE orders
  SET status = 'review'
  WHERE id = NEW.order_id
    AND status = 'pending';
END;

CREATE TABLE IF NOT EXISTS generations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL
    CHECK (kind IN ('ai', 'image', 'video', 'rerank')),
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_id TEXT UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS generations_user_created
ON generations(user_id, created_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL REFERENCES users(id),
  recipient_id TEXT NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS messages_sender
ON messages(sender_id, created_at);

CREATE INDEX IF NOT EXISTS messages_recipient
ON messages(recipient_id, created_at);
