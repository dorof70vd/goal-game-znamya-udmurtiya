// Проверка подписи initData, которую Telegram WebApp передаёt на фронтенде.
// Алгоритм из официальной документации:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

const crypto = require("crypto");

function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return { ok: false, reason: "MISSING_DATA" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "NO_HASH" };
  params.delete("hash");

  const pairs = [];
  for (const [key, value] of params.entries()) {
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (computedHash !== hash) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }

  // Необязательно, но полезно: отклонять совсем старые initData (> 24 часов)
  const authDate = Number(params.get("auth_date") || 0);
  if (authDate && Date.now() / 1000 - authDate > 24 * 60 * 60) {
    return { ok: false, reason: "EXPIRED" };
  }

  let user = null;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch (_) {
    user = null;
  }

  if (!user || !user.id) {
    return { ok: false, reason: "NO_USER" };
  }

  return { ok: true, user };
}

// Режим разработки: позволяет тестировать без реального Telegram-клиента.
// Включается только если явно выставлен DEV_ALLOW_FAKE_AUTH=1 — на проде должен быть выключен.
function verifyInitDataOrDev(initData, botToken) {
  const result = verifyInitData(initData, botToken);
  if (result.ok) return result;

  if (process.env.DEV_ALLOW_FAKE_AUTH === "1" && initData && initData.startsWith("dev:")) {
    const fakeId = initData.slice(4) || "000000";
    return { ok: true, user: { id: Number(fakeId) || 1, first_name: "Тест", username: "dev_user" } };
  }

  return result;
}

module.exports = { verifyInitData, verifyInitDataOrDev };
