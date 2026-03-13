function normalizePhone(rawValue, defaultCountryCode = "+34") {
  if (!rawValue || typeof rawValue !== "string") return null;

  let value = rawValue.trim().replace(/[^\d+]/g, "");
  if (!value) return null;

  if (value.startsWith("00")) {
    value = `+${value.slice(2)}`;
  }

  if (value.startsWith("+")) {
    const digits = value.slice(1).replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) return null;
    return `+${digits}`;
  }

  const localDigits = value.replace(/\D/g, "");
  if (localDigits.length < 8 || localDigits.length > 15) return null;

  const cc = defaultCountryCode.startsWith("+")
    ? defaultCountryCode
    : `+${defaultCountryCode}`;
  return `${cc}${localDigits}`;
}

module.exports = { normalizePhone };

