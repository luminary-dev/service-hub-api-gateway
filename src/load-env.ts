// Load .env before any other module reads process.env (config values like
// secrets and peer URLs are captured at import time). Missing file is fine —
// in Docker/CI the environment is provided directly.
try {
  process.loadEnvFile();
} catch {
  // no .env file — rely on the ambient environment
}
