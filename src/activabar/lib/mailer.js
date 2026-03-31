const nodemailer = require("nodemailer");
const env = require("../config/env");

let transporter;

function isMailerConfigured() {
  return Boolean(
    env.smtpHost &&
      env.smtpPort &&
      env.smtpUser &&
      env.smtpPass &&
      env.smtpFrom &&
      env.demoNotificationTo
  );
}

function getTransporter() {
  if (!isMailerConfigured()) {
    return null;
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpSecure,
      auth: {
        user: env.smtpUser,
        pass: env.smtpPass,
      },
    });
  }
  return transporter;
}

async function sendDemoRequestNotification(request) {
  const transport = getTransporter();
  if (!transport) {
    return { sent: false, skipped: true };
  }

  const subject = `Nueva solicitud demo: ${request.business_name}`;
  const text = [
    "Nueva solicitud de demo en ActivaBar",
    "",
    `Nombre: ${request.name}`,
    `Local: ${request.business_name}`,
    `Email: ${request.email}`,
    `Telefono: ${request.phone}`,
    `Ciudad: ${request.city || "-"}`,
    `Locales: ${request.locations_count || "-"}`,
    `Origen: ${request.source || "-"}`,
    `Fecha: ${request.created_at || "-"}`,
    "",
    "Mensaje:",
    request.message || "-",
  ].join("\n");

  await transport.sendMail({
    from: env.smtpFrom,
    to: env.demoNotificationTo,
    replyTo: request.email,
    subject,
    text,
  });

  return { sent: true };
}

module.exports = {
  isMailerConfigured,
  sendDemoRequestNotification,
};
