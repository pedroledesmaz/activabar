function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function resolveTwilioConfig(input = {}) {
  return {
    accountSid: String(input.accountSid || process.env.TWILIO_ACCOUNT_SID || "").trim(),
    authToken: String(input.authToken || process.env.TWILIO_AUTH_TOKEN || "").trim(),
    from: String(input.from || process.env.TWILIO_WHATSAPP_FROM || "").trim(),
  };
}

async function sendTwilioWhatsApp({ to, body, accountSid, authToken, from }) {
  const twilio = resolveTwilioConfig({ accountSid, authToken, from });
  const resolvedAccountSid = twilio.accountSid || requireEnv("TWILIO_ACCOUNT_SID");
  const resolvedAuthToken = twilio.authToken || requireEnv("TWILIO_AUTH_TOKEN");
  const resolvedFrom = twilio.from || requireEnv("TWILIO_WHATSAPP_FROM");

  const authHeader = Buffer.from(
    `${resolvedAccountSid}:${resolvedAuthToken}`
  ).toString("base64");

  const params = new URLSearchParams({
    To: `whatsapp:${to}`,
    From: `whatsapp:${resolvedFrom}`,
    Body: body,
  });

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${resolvedAccountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${authHeader}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    }
  );

  const payload = await response.json();
  if (!response.ok) {
    const reason = payload?.message || `Twilio error (${response.status})`;
    throw new Error(reason);
  }

  return {
    providerMessageId: payload.sid,
  };
}

async function sendWhatsAppMessage({ to, body, accountSid, authToken, from }) {
  const provider = process.env.WHATSAPP_PROVIDER || "mock";

  if (provider === "twilio") {
    return sendTwilioWhatsApp({ to, body, accountSid, authToken, from });
  }

  const fakeId = `mock_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  console.log(`[MOCK WHATSAPP] to=${to} body=${body}`);
  return { providerMessageId: fakeId };
}

module.exports = { sendWhatsAppMessage };
