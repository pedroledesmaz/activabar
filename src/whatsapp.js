function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

async function sendTwilioWhatsApp({ to, body }) {
  const accountSid = requireEnv("TWILIO_ACCOUNT_SID");
  const authToken = requireEnv("TWILIO_AUTH_TOKEN");
  const from = requireEnv("TWILIO_WHATSAPP_FROM");

  const authHeader = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  const params = new URLSearchParams({
    To: `whatsapp:${to}`,
    From: `whatsapp:${from}`,
    Body: body,
  });

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
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

async function sendWhatsAppMessage({ to, body }) {
  const provider = process.env.WHATSAPP_PROVIDER || "mock";

  if (provider === "twilio") {
    return sendTwilioWhatsApp({ to, body });
  }

  const fakeId = `mock_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  // eslint-disable-next-line no-console
  console.log(`[MOCK WHATSAPP] to=${to} body=${body}`);
  return { providerMessageId: fakeId };
}

module.exports = { sendWhatsAppMessage };

