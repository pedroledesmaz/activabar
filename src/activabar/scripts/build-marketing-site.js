const fs = require("fs/promises");
const path = require("path");
const {
  renderMarketingLanding,
  renderPrivacyPage,
} = require("../modules/app/public-site");

const outputDir = path.resolve(__dirname, "../../../marketing-site-dist");

async function writeFile(relativePath, contents) {
  const destination = path.join(outputDir, relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, contents, "utf8");
}

async function main() {
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  await writeFile(
    "index.html",
    renderMarketingLanding({
      dashboardHref: "https://app.activabar.es/login",
      privacyHref: "/privacy/",
    })
  );

  const privacyPage = renderPrivacyPage({ homeHref: "/" });
  await writeFile("privacy/index.html", privacyPage);
  await writeFile("privacy.html", privacyPage);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
