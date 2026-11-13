// Startup file for hosting panels that ask for an "Application startup file"
// (cPanel "Setup Node.js App" / Passenger, aaPanel, 1Panel, CloudPanel, PM2 ...).
// Equivalent to `npm start`. Requires a finished `npm run build` (.build/next).
// To cap memory, use the startup command `node --max-old-space-size=256 app.cjs`.
// CommonJS on purpose: some panel loaders `require()` the startup file.
process.chdir(__dirname);
process.argv[2] = "start";
import("./scripts/dev/run-next.mjs").catch((error) => {
  console.error("[FATAL] Failed to start TRouteAI:", error);
  process.exit(1);
});
