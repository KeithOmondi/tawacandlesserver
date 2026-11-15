-- TAWA Candles — initial schema. All money is whole Kenyan shillings (integer).

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL,
  password_hash     text NOT NULL,
  name              text NOT NULL,
  phone             text,
  role              text NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','admin')),
  email_verified_at timestamptz,
  failed_logins     integer NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  mfa_enabled       boolean NOT NULL DEFAULT false,
  mfa_secret_enc    text,
  mfa_last_step     bigint,
  mfa_recovery      jsonb NOT NULL DEFAULT '[]',
  disabled          boolean NOT NULL DEFAULT false,
  terms_version     text,
  privacy_version   text,
  consent_at        timestamptz,
  marketing_opt_in  boolean NOT NULL DEFAULT false,
  last_login_at     timestamptz,
  deleted_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

-- Refresh-token sessions (token itself is never stored, only its SHA-256).
CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  user_agent  text,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_family_idx ON sessions (family_id);

-- One-time email tokens (verification / password reset), stored hashed.
CREATE TABLE email_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('verify','reset')),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE addresses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       text NOT NULL DEFAULT 'Home',
  name        text NOT NULL,
  phone       text NOT NULL,
  line1       text NOT NULL,
  line2       text,
  city        text NOT NULL,
  region      text NOT NULL,
  postcode    text NOT NULL,
  country     text NOT NULL DEFAULT 'Kenya',
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX addresses_user_idx ON addresses (user_id);

CREATE TABLE products (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,
  name          text NOT NULL,
  tagline       text NOT NULL DEFAULT '',
  category      text NOT NULL,
  vessel        text NOT NULL CHECK (vessel IN ('jar','tin','tumbler','pillar')),
  wax           text NOT NULL DEFAULT '#f1d9a8',
  accent        text NOT NULL DEFAULT '#c98a3c',
  scent_family  text NOT NULL DEFAULT '',
  notes         jsonb NOT NULL DEFAULT '{}',
  description   text NOT NULL DEFAULT '',
  badge         text,
  compare_at    integer,
  stock         integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  featured      boolean NOT NULL DEFAULT false,
  active        boolean NOT NULL DEFAULT true,
  sort          integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE product_sizes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  code        text NOT NULL,
  label       text NOT NULL,
  weight      text NOT NULL DEFAULT '',
  burn        text NOT NULL DEFAULT '',
  price       integer NOT NULL CHECK (price >= 0),
  UNIQUE (product_id, code)
);

CREATE TABLE reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  name        text NOT NULL,
  rating      integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title       text NOT NULL DEFAULT '',
  body        text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','rejected')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reviews_product_idx ON reviews (product_id, status);
CREATE UNIQUE INDEX reviews_one_per_user ON reviews (product_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE wishlist (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE promo_codes (
  code          text PRIMARY KEY,
  type          text NOT NULL CHECK (type IN ('percent','fixed')),
  value         integer NOT NULL CHECK (value > 0),
  min_subtotal  integer NOT NULL DEFAULT 0,
  label         text NOT NULL DEFAULT '',
  active        boolean NOT NULL DEFAULT true,
  expires_at    timestamptz,
  max_uses      integer,
  used_count    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE order_seq START 1002;

CREATE TABLE orders (
  id              text PRIMARY KEY,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  email           text NOT NULL,
  name            text NOT NULL,
  phone           text NOT NULL,
  address         jsonb NOT NULL,
  delivery        text NOT NULL CHECK (delivery IN ('standard','express')),
  payment_method  text NOT NULL CHECK (payment_method IN ('mpesa','cod')),
  payment_status  text NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending','paid','failed','refunded')),
  status          text NOT NULL DEFAULT 'Pending payment'
                  CHECK (status IN ('Pending payment','Processing','Packed','Shipped','Delivered','Cancelled')),
  subtotal        integer NOT NULL,
  discount        integer NOT NULL DEFAULT 0,
  shipping        integer NOT NULL,
  total           integer NOT NULL,
  promo_code      text,
  gift_note       text,
  tracking_ref    text,
  stock_released  boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_user_idx ON orders (user_id);
CREATE INDEX orders_email_idx ON orders (lower(email));
CREATE INDEX orders_status_idx ON orders (status, created_at);

CREATE TABLE order_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  uuid REFERENCES products(id) ON DELETE SET NULL,
  name        text NOT NULL,
  size_code   text NOT NULL,
  size_label  text NOT NULL,
  price       integer NOT NULL,
  qty         integer NOT NULL CHECK (qty > 0)
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

CREATE TABLE payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider              text NOT NULL DEFAULT 'mpesa',
  phone                 text NOT NULL,
  amount                integer NOT NULL,
  checkout_request_id   text UNIQUE,
  merchant_request_id   text,
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed')),
  receipt               text UNIQUE,
  result_code           integer,
  result_desc           text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_order_idx ON payments (order_id);

CREATE TABLE messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  email       text NOT NULL,
  phone       text,
  subject     text NOT NULL,
  body        text NOT NULL,
  read        boolean NOT NULL DEFAULT false,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE custom_requests (
  id              text PRIMARY KEY,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  name            text NOT NULL,
  email           text NOT NULL,
  phone           text,
  vessel          text NOT NULL,
  size            text NOT NULL,
  color           text NOT NULL,
  scent           text NOT NULL,
  label           text NOT NULL DEFAULT '',
  occasion        text NOT NULL,
  quantity        integer NOT NULL CHECK (quantity > 0),
  needed_by       date,
  budget          text,
  notes           text,
  reference_file  text,
  estimate        integer NOT NULL,
  quoted_amount   integer,
  admin_notes     text,
  status          text NOT NULL DEFAULT 'New'
                  CHECK (status IN ('New','Quoted','Approved','In production','Completed','Declined')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscribers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  token       text NOT NULL UNIQUE,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subscribers_email_uq ON subscribers (lower(email));

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor_id     uuid,
  actor_email  text,
  action       text NOT NULL,
  target       text,
  ip           text,
  meta         jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_at_idx ON audit_log (at DESC);
CREATE INDEX audit_action_idx ON audit_log (action);

