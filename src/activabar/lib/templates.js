function renderTemplate(template, variables) {
  return String(template || "").replace(/\{([a-z0-9_]+)\}/gi, (_, key) => {
    const normalizedKey = String(key).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(variables, normalizedKey)) {
      return "";
    }

    const value = variables[normalizedKey];
    return value === undefined || value === null ? "" : String(value);
  });
}

module.exports = { renderTemplate };
