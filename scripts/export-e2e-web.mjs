// The browser suite's export: no Supabase project, so nothing reaches the network and no test bypass is compiled in.
// --clear because Metro's cache key ignores EXPO_PUBLIC_*; EXPO_NO_DOTENV stops .env refilling the blanks.
import { spawn } from "node:child_process";
import { copyFile, rm } from "node:fs/promises";

const output = "dist-e2e";
await rm(output, { recursive: true, force: true });

const child = spawn("npx", ["expo", "export", "-p", "web", "--clear", "--output-dir", output], {
  stdio: "inherit",
  env: { ...process.env, EXPO_PUBLIC_SUPABASE_URL: "", EXPO_PUBLIC_SUPABASE_ANON_KEY: "", EXPO_NO_DOTENV: "1" },
});
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (exit) => resolve(exit ?? 1));
});
if (code !== 0) process.exit(code);

// A deep link boots the app's own shell, as Pages serves it (`ci.yml`).
await copyFile(`${output}/index.html`, `${output}/404.html`);
